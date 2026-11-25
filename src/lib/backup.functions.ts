import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireMysqlAuth } from "@/integrations/mysql/auth-middleware";

const backupFormat = "cantilounge-hub-backup";
const tableNames = [
  "users",
  "user_roles",
  "categories",
  "ingredients",
  "menu_items",
  "recipe_ingredients",
  "orders",
  "order_items",
  "stock_transactions",
  "attendance_logs",
  "staff_face_descriptors",
  "order_audit_logs",
  "audit_logs",
] as const;
const backupSchema = z.object({
  format: z.literal(backupFormat),
  version: z.literal(1),
  createdAt: z.string().datetime(),
  tables: z.record(z.string(), z.array(z.record(z.string(), z.unknown()))),
});

type JsonRecord = Record<string, unknown> & import("mysql2/promise").RowDataPacket;
type Serializable =
  | string
  | number
  | boolean
  | null
  | Serializable[]
  | { [key: string]: Serializable };
type SerializableRecord = { [key: string]: Serializable };

function requireAdmin(roles: string[]) {
  if (!roles.some((role) => role === "ADMIN" || role === "OWNER")) {
    throw new Error("Only an owner or admin can manage database backups.");
  }
}

export const createDatabaseBackup = createServerFn({ method: "POST" })
  .middleware([requireMysqlAuth])
  .handler(async ({ context }) => {
    requireAdmin(context.roles);
    const { execute, identifier, queryRows, sqlValue } = await import("@/integrations/mysql/db.server");
    const tables: Record<string, SerializableRecord[]> = {};
    for (const table of tableNames) {
      tables[table] = JSON.parse(
        JSON.stringify(await queryRows<JsonRecord>(`SELECT * FROM ${identifier(table)}`)),
      ) as SerializableRecord[];
    }
    const backup = {
      format: backupFormat,
      version: 1 as const,
      createdAt: new Date().toISOString(),
      tables,
    };
    await execute(
      "INSERT INTO audit_logs (id, actor_user_id, actor_role, action_type, entity_type, entity_label, new_value) VALUES (UUID(), ?, ?, 'DATABASE_BACKUP_CREATED', 'DATABASE', 'Encrypted logical application backup', ?)",
      [context.userId, context.roles[0] ?? "SYSTEM", sqlValue({ created_at: backup.createdAt })],
    );
    return JSON.parse(JSON.stringify(backup)) as {
      format: string;
      version: 1;
      createdAt: string;
      tables: Record<string, SerializableRecord[]>;
    };
  });

export const restoreDatabaseBackup = createServerFn({ method: "POST" })
  .middleware([requireMysqlAuth])
  .validator((input) => z.object({ backup: backupSchema }).parse(input))
  .handler(async ({ data, context }) => {
    requireAdmin(context.roles);
    const { identifier, sqlValue, withTransaction } = await import("@/integrations/mysql/db.server");
    await withTransaction(async (connection) => {
      const restoreOrder = [
        "users",
        "user_roles",
        "categories",
        "ingredients",
        "menu_items",
        "recipe_ingredients",
        "orders",
        "order_items",
        "stock_transactions",
        "attendance_logs",
        "staff_face_descriptors",
        "order_audit_logs",
        "audit_logs",
      ] as const;
      for (const table of restoreOrder) {
        const rows = data.backup.tables[table] ?? [];
        for (const row of rows) {
          const columns = Object.keys(row);
          if (columns.length === 0) continue;
          const mutableColumns = columns.filter((column) => column !== "id" && column !== "user_id");
          const updates = table === "audit_logs" || table === "order_audit_logs"
            ? "id = VALUES(id)"
            : mutableColumns.length
              ? mutableColumns.map((column) => `${identifier(column)} = VALUES(${identifier(column)})`).join(", ")
              : `${identifier(columns[0]!)} = VALUES(${identifier(columns[0]!)})`;
          const insert = table === "audit_logs" || table === "order_audit_logs"
            ? "INSERT IGNORE"
            : "INSERT";
          await connection.execute(
            `${insert} INTO ${identifier(table)} (${columns.map(identifier).join(", ")}) VALUES (${columns.map(() => "?").join(", ")}) ON DUPLICATE KEY UPDATE ${updates}`,
            columns.map((column) => sqlValue(row[column])),
          );
        }
      }
      await connection.execute(
        "INSERT INTO audit_logs (id, actor_user_id, actor_role, action_type, entity_type, entity_label, new_value) VALUES (UUID(), ?, ?, 'DATABASE_RESTORED', 'DATABASE', 'Application data', ?)",
        [context.userId, context.roles[0] ?? "ADMIN", JSON.stringify({ source_version: data.backup.version })],
      );
    });
    return { restored: true };
  });
