import { getMysqlSession } from "@/integrations/mysql/auth.functions";
import { mysql } from "@/integrations/mysql/client";
import type { Role } from "./staff-auth";

export type StaffSession = {
  userId: string;
  fullName: string;
  staffCode: string;
  roles: Role[];
};

// Cached in localStorage so the POS can boot offline after a prior sign-in.
const KEY = "cl-staff-session";

export async function loadStaffSession(): Promise<StaffSession | null> {
  if (!navigator.onLine) {
    const cached = localStorage.getItem(KEY);
    return cached ? (JSON.parse(cached) as StaffSession) : null;
  }
  const session = await getMysqlSession();
  if (!session) return null;
  const [{ data: profile }, { data: roles }] = await Promise.all([
    mysql
      .from("staff_profiles")
      .select("full_name, staff_code, is_active")
      .eq("id", session.userId)
      .maybeSingle(),
    mysql.from("user_roles").select("role").eq("user_id", session.userId),
  ]);
  if (!profile || !profile.is_active) return null;
  const s: StaffSession = {
    userId: session.userId,
    fullName: profile.full_name,
    staffCode: profile.staff_code,
    roles: (roles ?? []).map((r) => r.role as Role),
  };
  localStorage.setItem(KEY, JSON.stringify(s));
  return s;
}

export function clearStaffSessionCache() {
  localStorage.removeItem(KEY);
}

export function homeFor(roles: Role[]): "/pos" | "/clock" {
  if (roles.some((r) => ["ADMIN", "MANAGER", "CASHIER"].includes(r))) return "/pos";
  return "/clock";
}
