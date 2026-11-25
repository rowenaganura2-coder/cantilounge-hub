import { createMiddleware } from "@tanstack/react-start";

export const requireMysqlAuth = createMiddleware({ type: "function" }).server(async ({ next }) => {
  const { requireStaff } = await import("./auth.server");
  const staff = await requireStaff();
  return next({
    context: {
      userId: staff.id,
      roles: staff.roles,
      staff,
    },
  });
});
