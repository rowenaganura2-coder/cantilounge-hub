// Staff sign in with a staff code + PIN. The auth system needs an email and a
// 6+ char password, so both are derived deterministically. The PIN is never
// stored in app tables — it is hashed by the auth system as the password.
export const STAFF_EMAIL_DOMAIN = "staff.cantilounge.app";

export function staffEmail(staffCode: string) {
  return `${staffCode.trim().toLowerCase()}@${STAFF_EMAIL_DOMAIN}`;
}

export function pinPassword(pin: string) {
  return `cl-pin-${pin}`;
}

export const ROLES = ["OWNER", "ADMIN", "MANAGER", "CASHIER", "BARISTA", "KITCHEN"] as const;
export type Role = (typeof ROLES)[number];

export function hasAny(roles: Role[], wanted: Role[]) {
  return roles.some((r) => wanted.includes(r));
}

export const peso = (n: number | string) =>
  `₱${Number(n).toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
