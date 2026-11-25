import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

const rpcInput = z.object({
  name: z.string(),
  args: z.record(z.string(), z.unknown()).default({}),
});

export const executeMysqlRpc = createServerFn({ method: "POST" })
  .validator((input) => rpcInput.parse(input))
  .handler(async ({ data }) =>
    (await import("./rpc.server")).runMysqlRpc(data.name, data.args),
  );
