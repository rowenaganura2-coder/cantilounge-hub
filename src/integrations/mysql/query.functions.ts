import { createServerFn } from "@tanstack/react-start";
import { querySchema } from "./query.contract";

export const executeMysqlQuery = createServerFn({ method: "POST" })
  .validator((input) => querySchema.parse(input))
  .handler(async ({ data }) =>
    (await import("./query.server")).executeMysqlQueryServer(data),
  );
