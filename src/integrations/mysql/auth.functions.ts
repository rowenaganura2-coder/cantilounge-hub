import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

export type MysqlRole = "OWNER" | "ADMIN" | "MANAGER" | "CASHIER" | "BARISTA" | "KITCHEN";
export type MysqlSession = { userId: string; exp: number };

export const signInStaff = createServerFn({ method: "POST" })
  .validator((input) =>
    z.object({ staffCode: z.string().trim().min(2).max(16), pin: z.string().regex(/^\d{4,6}$/) }).parse(input),
  )
  .handler(async ({ data }) => (await import("./auth.server")).signInStaffServer(data));

export const getMysqlSession = createServerFn({ method: "GET" }).handler(async () =>
  (await import("./auth.server")).getMysqlSessionServer(),
);

export const signOutStaff = createServerFn({ method: "POST" }).handler(async () =>
  (await import("./auth.server")).signOutStaffServer(),
);
