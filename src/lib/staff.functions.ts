import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireMysqlAuth } from "@/integrations/mysql/auth-middleware";
import { ROLES, type Role } from "./staff-auth";

const staffInput = z.object({
  fullName: z.string().trim().min(2).max(80),
  staffCode: z.string().trim().regex(/^[a-zA-Z0-9]{2,16}$/, "Letters and numbers only"),
  pin: z.string().regex(/^\d{4,6}$/, "PIN must be 4–6 digits"),
  hourlyRate: z.number().min(0).max(100000),
  roles: z.array(z.enum(ROLES)).min(1),
});

type CountRow = { total: number } & import("mysql2/promise").RowDataPacket;

async function createStaffAccount(input: z.infer<typeof staffInput>) {
  const id = crypto.randomUUID();
  const { withTransaction } = await import("@/integrations/mysql/db.server");
  const { hashPin } = await import("@/integrations/mysql/auth.server");
  const passwordHash = await hashPin(input.pin);
  await withTransaction(async (connection) => {
    await connection.execute(
      "INSERT INTO users (id, staff_code, full_name, password_hash, role, hourly_rate) VALUES (?, ?, ?, ?, ?, ?)",
      [
        id,
        input.staffCode.toLowerCase(),
        input.fullName,
        passwordHash,
        input.roles[0] ?? "CASHIER",
        input.hourlyRate,
      ],
    );
    for (const role of input.roles) {
      await connection.execute("INSERT INTO user_roles (id, user_id, role) VALUES (UUID(), ?, ?)", [
        id,
        role,
      ]);
    }
  });
  return { id };
}

export const bootstrapOwner = createServerFn({ method: "POST" })
  .validator((input) => staffInput.omit({ roles: true }).parse(input))
  .handler(async ({ data }) => {
    const { queryRows } = await import("@/integrations/mysql/db.server");
    const [count] = await queryRows<CountRow>("SELECT COUNT(*) AS total FROM users");
    if (Number(count?.total ?? 0) > 0) throw new Error("Setup already completed.");
    return createStaffAccount({ ...data, roles: ["ADMIN"] });
  });

export const createStaff = createServerFn({ method: "POST" })
  .middleware([requireMysqlAuth])
  .validator((input) => staffInput.parse(input))
  .handler(async ({ data, context }) => {
    if (!context.roles.some((role) => ["OWNER", "ADMIN", "MANAGER"].includes(role))) {
      throw new Error("Forbidden");
    }
    if (
      data.roles.some((role) => role === "ADMIN" || role === "OWNER") &&
      !context.roles.some((role) => role === "OWNER" || role === "ADMIN")
    ) {
      throw new Error("Only an owner or admin can create an admin.");
    }
    const { execute, sqlValue } = await import("@/integrations/mysql/db.server");
    const created = await createStaffAccount(data);
    await execute(
      "INSERT INTO audit_logs (id, actor_user_id, actor_role, action_type, entity_type, entity_id, entity_label, new_value) VALUES (UUID(), ?, ?, 'STAFF_CREATED', 'STAFF', ?, ?, ?)",
      [
        context.userId,
        context.roles[0] ?? "SYSTEM",
        created.id,
        data.fullName,
        sqlValue({ staffCode: data.staffCode, roles: data.roles }),
      ],
    );
    return created;
  });

export const resetStaffPin = createServerFn({ method: "POST" })
  .middleware([requireMysqlAuth])
  .validator((input) =>
    z.object({ userId: z.string().uuid(), pin: z.string().regex(/^\d{4,6}$/) }).parse(input),
  )
  .handler(async ({ data, context }) => {
    if (!context.roles.some((role) => ["OWNER", "ADMIN", "MANAGER"].includes(role))) {
      throw new Error("Forbidden");
    }
    if (
      context.userId === data.userId &&
      !context.roles.some((role) => role === "OWNER" || role === "ADMIN")
    ) {
      throw new Error("Only an owner or admin can reset a staff PIN.");
    }
    const { execute } = await import("@/integrations/mysql/db.server");
    const { hashPin } = await import("@/integrations/mysql/auth.server");
    const hash = await hashPin(data.pin);
    await execute("UPDATE users SET password_hash = ? WHERE id = ?", [hash, data.userId]);
    await execute(
      "INSERT INTO audit_logs (id, actor_user_id, actor_role, action_type, entity_type, entity_id, entity_label) VALUES (UUID(), ?, ?, 'STAFF_PIN_RESET', 'STAFF', ?, 'Staff PIN')",
      [context.userId, context.roles[0] ?? "SYSTEM", data.userId],
    );
    return { ok: true };
  });
