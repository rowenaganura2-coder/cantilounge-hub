import { z } from "zod";

const filterSchema = z.object({
  column: z.string(),
  operator: z.enum(["eq", "neq", "is", "gte", "gt", "lte", "lt", "in", "not_is"]),
  value: z.unknown(),
});

export const querySchema = z.object({
  table: z.string(),
  operation: z.enum(["select", "insert", "update", "upsert", "delete"]),
  values: z.unknown().optional(),
  filters: z.array(filterSchema).default([]),
  order: z.array(z.object({ column: z.string(), ascending: z.boolean() })).default([]),
  offset: z.number().int().min(0).default(0),
  limit: z.number().int().min(1).max(5000).default(1000),
  selection: z.string().default("*"),
  count: z.boolean().default(false),
  head: z.boolean().default(false),
});

export type MysqlQueryInput = z.infer<typeof querySchema>;
