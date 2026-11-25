import { deleteCookie, getCookie, setCookie } from "@tanstack/react-start/server";
import { createHmac, randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { queryRows } from "./db.server";
import type { MysqlRole, MysqlSession } from "./auth.functions";

const scrypt = promisify(scryptCallback);
const SESSION_COOKIE = "cantilounge_session";
const SESSION_SECONDS = 60 * 60 * 12;

function sessionSecret() {
  const secret = process.env["SESSION_SECRET"];
  if (secret) return secret;
  if (process.env["NODE_ENV"] === "production") {
    throw new Error("SESSION_SECRET must be configured for production.");
  }
  return "local-development-only-change-this-session-secret";
}

function sign(value: string) {
  return createHmac("sha256", sessionSecret()).update(value).digest("base64url");
}

export function readSession(): MysqlSession | null {
  const token = getCookie(SESSION_COOKIE);
  if (!token) return null;
  const [encoded, signature] = token.split(".");
  if (!encoded || !signature || !timingSafeEqual(Buffer.from(signature), Buffer.from(sign(encoded)))) {
    return null;
  }
  try {
    const data = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as MysqlSession;
    return data.exp > Math.floor(Date.now() / 1000) ? data : null;
  } catch {
    return null;
  }
}

export async function hashPin(pin: string) {
  const salt = randomBytes(16);
  const hash = (await scrypt(pin, salt, 64)) as Buffer;
  return `scrypt$${salt.toString("hex")}$${hash.toString("hex")}`;
}

export async function verifyPin(pin: string, stored: string) {
  const [scheme, saltHex, hashHex] = stored.split("$");
  if (scheme !== "scrypt" || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, "hex");
  const actual = (await scrypt(pin, Buffer.from(saltHex, "hex"), expected.length)) as Buffer;
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export async function signInStaffServer(data: { staffCode: string; pin: string }) {
  const users = await queryRows<{
    id: string;
    password_hash: string;
    is_active: number;
  } & import("mysql2/promise").RowDataPacket>(
    "SELECT id, password_hash, is_active FROM users WHERE staff_code = ? LIMIT 1",
    [data.staffCode.toLowerCase()],
  );
  const user = users[0];
  if (!user || !user.is_active || !(await verifyPin(data.pin, user.password_hash))) {
    throw new Error("Wrong PIN or inactive account.");
  }
  const session: MysqlSession = {
    userId: user.id,
    exp: Math.floor(Date.now() / 1000) + SESSION_SECONDS,
  };
  const encoded = Buffer.from(JSON.stringify(session)).toString("base64url");
  setCookie(SESSION_COOKIE, `${encoded}.${sign(encoded)}`, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env["NODE_ENV"] === "production",
    path: "/",
    maxAge: SESSION_SECONDS,
  });
  return { userId: user.id };
}

export async function getMysqlSessionServer() {
  const session = readSession();
  return session ? { userId: session.userId } : null;
}

export function signOutStaffServer() {
  deleteCookie(SESSION_COOKIE, { path: "/" });
  return { ok: true };
}

export async function requireStaff() {
  const session = readSession();
  if (!session) throw new Error("Unauthorized");
  const users = await queryRows<{
    id: string;
    is_active: number;
    full_name: string;
    staff_code: string;
  } & import("mysql2/promise").RowDataPacket>(
    "SELECT id, is_active, full_name, staff_code FROM users WHERE id = ? LIMIT 1",
    [session.userId],
  );
  const user = users[0];
  if (!user || !user.is_active) throw new Error("Unauthorized");
  const roles = await queryRows<{ role: MysqlRole } & import("mysql2/promise").RowDataPacket>(
    "SELECT role FROM user_roles WHERE user_id = ? ORDER BY role",
    [user.id],
  );
  if (roles.length === 0) throw new Error("Forbidden");
  return { ...user, roles: roles.map((item) => item.role) };
}
