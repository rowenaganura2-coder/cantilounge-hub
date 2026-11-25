import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireMysqlAuth } from "@/integrations/mysql/auth-middleware";

const descriptorInput = z.array(z.number().finite()).length(128);
const clockActionInput = z.object({
  descriptor: descriptorInput,
  action: z.enum(["CLOCK_IN", "CLOCK_OUT"]),
  breakMinutes: z.number().int().min(0).max(240).default(0),
});

type FaceRecord = {
  user_id: string;
  descriptor: number[] | string;
} & import("mysql2/promise").RowDataPacket;

function storedDescriptor(value: FaceRecord["descriptor"]): number[] | null {
  const parsed = typeof value === "string" ? JSON.parse(value) as unknown : value;
  if (!Array.isArray(parsed) || parsed.length !== 128) return null;
  if (!parsed.every((part) => typeof part === "number" && Number.isFinite(part))) return null;
  return parsed;
}

function distance(left: number[], right: number[]) {
  let total = 0;
  for (let index = 0; index < left.length; index += 1) {
    const value = left[index];
    const other = right[index];
    if (value === undefined || other === undefined) return Number.POSITIVE_INFINITY;
    total += (value - other) ** 2;
  }
  return Math.sqrt(total);
}

async function findMatch(descriptor: number[]) {
  const { queryRows } = await import("@/integrations/mysql/db.server");
  const faceRecords = await queryRows<FaceRecord>(
    "SELECT user_id, descriptor FROM staff_face_descriptors",
  );
  const matches = faceRecords
    .flatMap((profile) => {
      const saved = storedDescriptor(profile.descriptor);
      return saved ? [{ profile, distance: distance(descriptor, saved) }] : [];
    })
    .sort((a, b) => a.distance - b.distance);
  const best = matches[0];
  if (!best || best.distance > 0.48) return null;
  if (matches[1] && matches[1].distance - best.distance < 0.04) return null;
  const profiles = await queryRows<{ id: string; full_name: string } & import("mysql2/promise").RowDataPacket>(
    "SELECT id, full_name FROM users WHERE id = ? AND is_active = TRUE LIMIT 1",
    [best.profile.user_id],
  );
  return profiles[0] ?? null;
}

export const saveFaceEnrollment = createServerFn({ method: "POST" })
  .middleware([requireMysqlAuth])
  .validator((input) => z.object({ descriptor: descriptorInput }).parse(input))
  .handler(async ({ data, context }) => {
    const { execute } = await import("@/integrations/mysql/db.server");
    await execute(
      "INSERT INTO staff_face_descriptors (user_id, descriptor, enrolled_at) VALUES (?, ?, CURRENT_TIMESTAMP(3)) ON DUPLICATE KEY UPDATE descriptor = VALUES(descriptor), enrolled_at = VALUES(enrolled_at)",
      [context.userId, JSON.stringify(data.descriptor)],
    );
    return { saved: true };
  });

export const matchStaffFace = createServerFn({ method: "POST" })
  .middleware([requireMysqlAuth])
  .validator((input) => z.object({ descriptor: descriptorInput }).parse(input))
  .handler(async ({ data }) => {
    const { queryRows } = await import("@/integrations/mysql/db.server");
    const profile = await findMatch(data.descriptor);
    if (!profile) return null;
    const [roles, shifts] = await Promise.all([
      queryRows<{ role: string } & import("mysql2/promise").RowDataPacket>(
        "SELECT role FROM user_roles WHERE user_id = ? ORDER BY role",
        [profile.id],
      ),
      queryRows<{ clock_in: string } & import("mysql2/promise").RowDataPacket>(
        "SELECT clock_in FROM attendance_logs WHERE user_id = ? AND clock_out IS NULL ORDER BY clock_in DESC LIMIT 1",
        [profile.id],
      ),
    ]);
    return {
      fullName: profile.full_name,
      role: roles.map((item) => item.role).join(", "),
      clockedIn: Boolean(shifts[0]),
    };
  });

export const recordFaceAttendance = createServerFn({ method: "POST" })
  .middleware([requireMysqlAuth])
  .validator((input) => clockActionInput.parse(input))
  .handler(async ({ data }) => {
    const profile = await findMatch(data.descriptor);
    if (!profile) throw new Error("No matching staff face was found.");
    const { runMysqlRpc } = await import("@/integrations/mysql/rpc.server");
    await runMysqlRpc("record_verified_attendance", {
      _user_id: profile.id,
      _action: data.action,
      _break_minutes: data.breakMinutes,
      _verification_method: "FACE_ID",
      _override_by: null,
    });
    return { fullName: profile.full_name, action: data.action };
  });

export const recordAdminPinOverride = createServerFn({ method: "POST" })
  .middleware([requireMysqlAuth])
  .validator((input) =>
    z
      .object({
        targetUserId: z.string().uuid(),
        adminPin: z.string().regex(/^\d{4,6}$/),
        action: z.enum(["CLOCK_IN", "CLOCK_OUT"]),
        breakMinutes: z.number().int().min(0).max(240).default(0),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    if (!context.roles.includes("ADMIN") && !context.roles.includes("OWNER")) {
      throw new Error("Only an admin can authorize a PIN override.");
    }
    const { queryRows } = await import("@/integrations/mysql/db.server");
    const adminRows = await queryRows<{ password_hash: string } & import("mysql2/promise").RowDataPacket>(
      "SELECT password_hash FROM users WHERE id = ? AND is_active = TRUE LIMIT 1",
      [context.userId],
    );
    const admin = adminRows[0];
    const { verifyPin } = await import("@/integrations/mysql/auth.server");
    if (!admin || !(await verifyPin(data.adminPin, admin.password_hash))) {
      throw new Error("Admin PIN verification failed.");
    }
    const targets = await queryRows<{ id: string; full_name: string } & import("mysql2/promise").RowDataPacket>(
      "SELECT id, full_name FROM users WHERE id = ? AND is_active = TRUE LIMIT 1",
      [data.targetUserId],
    );
    const target = targets[0];
    if (!target) throw new Error("Could not find active staff member.");
    const { runMysqlRpc } = await import("@/integrations/mysql/rpc.server");
    await runMysqlRpc("record_verified_attendance", {
      _user_id: target.id,
      _action: data.action,
      _break_minutes: data.breakMinutes,
      _verification_method: "PIN_OVERRIDE",
      _override_by: context.userId,
    });
    return { fullName: target.full_name, action: data.action };
  });
