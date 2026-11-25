import type { MysqlQueryInput } from "./query.contract";
import type { requireStaff } from "./auth.server";
import { execute, identifier, queryRows, sqlValue } from "./db.server";

const columns: Record<string, string[]> = {
  staff_profiles: ["id", "full_name", "staff_code", "hourly_rate", "is_active", "created_at"],
  user_roles: ["user_id", "role"],
  categories: ["id", "name", "sort_order"],
  ingredients: [
    "id",
    "name",
    "unit",
    "cost_per_unit",
    "current_stock",
    "min_threshold",
    "reorder_level",
    "expires_at",
    "low_stock_notified_at",
    "is_available",
    "created_at",
  ],
  menu_items: [
    "id",
    "name",
    "category_id",
    "base_price",
    "target_station",
    "is_available",
    "is_active",
    "image_url",
    "created_at",
  ],
  recipe_ingredients: ["id", "menu_item_id", "ingredient_id", "quantity_req"],
  orders: [
    "id",
    "client_id",
    "order_number",
    "order_type",
    "status",
    "customer_name",
    "table_number",
    "total_amount",
    "discount_type",
    "discount_amount",
    "cashier_id",
    "created_offline",
    "payment_method",
    "cash_received",
    "gcash_amount",
    "gcash_reference",
    "payment_reference",
    "settled_at",
    "created_at",
  ],
  order_items: [
    "id",
    "order_id",
    "menu_item_id",
    "name",
    "station",
    "quantity",
    "modifiers",
    "item_price",
    "item_status",
    "created_at",
  ],
  stock_transactions: ["id", "ingredient_id", "change", "reason", "order_id", "user_id", "created_at"],
  attendance_logs: [
    "id",
    "user_id",
    "clock_in",
    "clock_out",
    "break_minutes",
    "total_hours",
    "overtime_min",
    "is_late",
    "verification_method",
    "override_by",
    "notes",
  ],
  staff_face_descriptors: ["user_id", "descriptor", "enrolled_at"],
  order_audit_logs: [
    "id",
    "order_id",
    "employee_id",
    "action",
    "reason",
    "before_state",
    "after_state",
    "created_at",
  ],
  audit_logs: [
    "id",
    "actor_user_id",
    "actor_role",
    "action_type",
    "entity_type",
    "entity_id",
    "entity_label",
    "old_value",
    "new_value",
    "created_at",
  ],
};

const tableNames = Object.keys(columns);

function assertColumn(table: string, column: string) {
  if (!columns[table]?.includes(column)) throw new Error(`Unknown ${table} column: ${column}`);
}

function whereClause(table: string, filters: MysqlQueryInput["filters"]) {
  const clauses: string[] = [];
  const values: import("mysql2/promise").ExecuteValues[] = [];
  for (const filter of filters) {
    assertColumn(table, filter.column);
    const column = identifier(filter.column);
    if (filter.operator === "is" || filter.operator === "not_is") {
      if (filter.value !== null && filter.value !== true && filter.value !== false) {
        throw new Error("The is filter only accepts null or boolean values.");
      }
      clauses.push(`${column} ${filter.operator === "not_is" ? "IS NOT" : "IS"} ?`);
      values.push(sqlValue(filter.value));
    } else if (filter.operator === "in") {
      if (!Array.isArray(filter.value) || filter.value.length === 0) {
        clauses.push("1 = 0");
      } else {
        clauses.push(`${column} IN (${filter.value.map(() => "?").join(", ")})`);
        values.push(...filter.value.map(sqlValue));
      }
    } else {
      const operator = { eq: "=", neq: "<>", gte: ">=", gt: ">", lte: "<=", lt: "<" }[
        filter.operator
      ];
      clauses.push(`${column} ${operator} ?`);
      values.push(sqlValue(filter.value));
    }
  }
  return { sql: clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "", values };
}

async function assertPermission(table: string, operation: string, actor: Awaited<ReturnType<typeof requireStaff>>) {
  const managerTables = new Set([
    "ingredients",
    "recipe_ingredients",
    "stock_transactions",
    "staff_profiles",
    "user_roles",
    "audit_logs",
    "staff_face_descriptors",
  ]);
  if (managerTables.has(table) && !actor.roles.some((role) => role === "OWNER" || role === "ADMIN" || role === "MANAGER")) {
    if (!["staff_profiles", "user_roles", "staff_face_descriptors"].includes(table)) {
      throw new Error("Forbidden");
    }
  }
  if (table === "audit_logs" && operation !== "select") throw new Error("Audit logs are append-only.");
  if (
    ["menu_items", "categories"].includes(table) &&
    operation !== "select" &&
    !actor.roles.some((role) => ["OWNER", "ADMIN", "MANAGER"].includes(role))
  ) {
    throw new Error("Forbidden");
  }
  if (
    (table === "staff_profiles" || table === "user_roles" || table === "staff_face_descriptors" || table === "attendance_logs") &&
    !actor.roles.some((role) => ["OWNER", "ADMIN", "MANAGER"].includes(role))
  ) {
    const target = actor.id;
    if (
      operation !== "select" &&
      !(table === "staff_face_descriptors" && operation === "upsert")
    ) {
      throw new Error("Forbidden");
    }
    return target;
  }
  if (table === "audit_logs" && !actor.roles.some((role) => ["OWNER", "ADMIN"].includes(role))) {
    throw new Error("Forbidden");
  }
  return null;
}

type SelectionRelation = { relation: string; fields: string[]; nested: SelectionRelation[] };

function splitSelection(selection: string) {
  const fields: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < selection.length; index += 1) {
    const character = selection[index];
    if (character === "(") depth += 1;
    if (character === ")") depth -= 1;
    if (character === "," && depth === 0) {
      fields.push(selection.slice(start, index).trim());
      start = index + 1;
    }
  }
  const tail = selection.slice(start).trim();
  if (tail) fields.push(tail);
  return fields;
}

function parseSelection(selection: string, table: string) {
  const selected: string[] = [];
  const nested: SelectionRelation[] = [];
  for (const field of splitSelection(selection)) {
    const relationStart = field.indexOf("(");
    if (relationStart > 0 && field.endsWith(")")) {
      const relation = field.slice(0, relationStart).trim();
      const child = parseSelection(field.slice(relationStart + 1, -1), relation);
      nested.push({ relation, fields: child.selected, nested: child.nested });
    } else {
      selected.push(field);
    }
  }
  const result = selected.includes("*") || selected.length === 0 ? columns[table]! : selected;
  result.forEach((column) => assertColumn(table, column));
  return { selected: result, nested };
}

async function attachRelations(
  table: string,
  rows: Record<string, unknown>[],
  nested: SelectionRelation[],
) {
  if (!rows.length) return rows;
  for (const relation of nested) {
    if (relation.relation === "user_roles" && table === "staff_profiles") {
      relation.fields.forEach((field) => assertColumn("user_roles", field));
      const ids = rows.map((row) => row["id"]).filter((id): id is string => typeof id === "string");
      const roles = await queryRows<Record<string, unknown> & import("mysql2/promise").RowDataPacket>(
        `SELECT user_id, ${relation.fields.map(identifier).join(", ")} FROM user_roles WHERE user_id IN (${ids.map(() => "?").join(", ")})`,
        ids,
      );
      for (const row of rows) row["user_roles"] = roles.filter((role) => role["user_id"] === row["id"]);
    } else if (relation.relation === "categories" && table === "menu_items") {
      const ids = [...new Set(rows.map((row) => row["category_id"]).filter((id): id is string => typeof id === "string"))];
      const categories = await queryRows<Record<string, unknown> & import("mysql2/promise").RowDataPacket>(
        `SELECT id, ${relation.fields.map((field) => {
          assertColumn("categories", field);
          return identifier(field);
        }).join(", ")} FROM categories WHERE id IN (${ids.map(() => "?").join(", ")})`,
        ids,
      );
      for (const row of rows) row["categories"] = categories.find((category) => category["id"] === row["category_id"]) ?? null;
    } else if (relation.relation === "recipe_ingredients" && table === "menu_items") {
      const ids = [...new Set(rows.map((row) => row["id"]).filter((id): id is string => typeof id === "string"))];
      const recipes = await queryRows<Record<string, unknown> & import("mysql2/promise").RowDataPacket>(
        `SELECT id, menu_item_id, ingredient_id, ${relation.fields.filter((field) => field !== "ingredients").map((field) => {
          assertColumn("recipe_ingredients", field);
          return identifier(field);
        }).join(", ")} FROM recipe_ingredients WHERE menu_item_id IN (${ids.map(() => "?").join(", ")})`,
        ids,
      );
      await attachRelations("recipe_ingredients", recipes, relation.nested);
      for (const row of rows) {
        row["recipe_ingredients"] = recipes.filter((recipe) => recipe["menu_item_id"] === row["id"]);
      }
    } else if (relation.relation === "ingredients" && table === "recipe_ingredients") {
      const ids = [...new Set(rows.map((row) => row["ingredient_id"]).filter((id): id is string => typeof id === "string"))];
      const ingredients = await queryRows<Record<string, unknown> & import("mysql2/promise").RowDataPacket>(
        `SELECT id, ${relation.fields.map((field) => {
          assertColumn("ingredients", field);
          return identifier(field);
        }).join(", ")} FROM ingredients WHERE id IN (${ids.map(() => "?").join(", ")})`,
        ids,
      );
      for (const row of rows) row["ingredients"] = ingredients.find((ingredient) => ingredient["id"] === row["ingredient_id"]) ?? null;
    } else if (relation.relation === "staff_profiles" && table === "attendance_logs") {
      relation.fields.forEach((field) => assertColumn("staff_profiles", field));
      const ids = [...new Set(rows.map((row) => row["user_id"]).filter((id): id is string => typeof id === "string"))];
      const profiles = await queryRows<Record<string, unknown> & import("mysql2/promise").RowDataPacket>(
        `SELECT id, ${relation.fields.map(identifier).join(", ")} FROM users WHERE id IN (${ids.map(() => "?").join(", ")})`,
        ids,
      );
      for (const row of rows) row["staff_profiles"] = profiles.find((profile) => profile["id"] === row["user_id"]) ?? null;
    } else {
      throw new Error(`Unsupported relation selection: ${relation.relation}`);
    }
  }
  return rows;
}

async function runQuery(input: MysqlQueryInput) {
  const { table, operation, filters, order, offset, limit, selection, count, head } = input;
  if (!tableNames.includes(table)) throw new Error(`Unknown table: ${table}`);
  const { requireStaff } = await import("./auth.server");
  const actor = await requireStaff();
  const ownId = await assertPermission(table, operation, actor);
  const scopedFilters = ownId
    ? [...filters, { column: ["user_roles", "attendance_logs", "staff_face_descriptors"].includes(table) ? "user_id" : "id", operator: "eq" as const, value: ownId }]
    : filters;
  scopedFilters.forEach((filter) => assertColumn(table, filter.column));
  if (operation === "select") {
    const { selected, nested } = parseSelection(selection, table);
    const where = whereClause(table, scopedFilters);
    const sort = order.map(({ column, ascending }) => {
      assertColumn(table, column);
      return `${identifier(column)} ${ascending ? "ASC" : "DESC"}`;
    });
    const from = table === "staff_profiles" ? "users" : identifier(table);
    const fields = selected.map(identifier).join(", ");
    const [rows, countRows] = await Promise.all([
      head
        ? Promise.resolve([])
        : queryRows<Record<string, unknown> & import("mysql2/promise").RowDataPacket>(
            `SELECT ${fields} FROM ${from}${where.sql}${sort.length ? ` ORDER BY ${sort.join(", ")}` : ""} LIMIT ${limit} OFFSET ${offset}`,
            where.values,
          ),
      count
        ? queryRows<{ total: number } & import("mysql2/promise").RowDataPacket>(
            `SELECT COUNT(*) AS total FROM ${from}${where.sql}`,
            where.values,
          )
        : Promise.resolve([]),
    ]);
    return {
      data: await attachRelations(table, rows, nested),
      count: count ? Number(countRows[0]?.total ?? 0) : null,
    };
  }
  if (operation === "insert" || operation === "upsert") {
    const list = Array.isArray(input.values) ? input.values : [input.values];
    if (!list.length) return { data: [], count: 0 };
    const records = list.map((value) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid insert record.");
      const record = value as Record<string, unknown>;
      Object.keys(record).forEach((column) => assertColumn(table, column));
      return record;
    });
    const keys = [...new Set(records.flatMap((record) => Object.keys(record)))];
    const placeholders = records.map(() => `(${keys.map(() => "?").join(", ")})`).join(", ");
    const values = records.flatMap((record) => keys.map((key) => sqlValue(record[key])));
    const updates = operation === "upsert"
      ? ` ON DUPLICATE KEY UPDATE ${keys.filter((key) => key !== "id").map((key) => `${identifier(key)} = VALUES(${identifier(key)})`).join(", ") || `${identifier(keys[0]!)} = VALUES(${identifier(keys[0]!)})`}`
      : "";
    const target = table === "staff_profiles" ? "users" : identifier(table);
    const result = await execute(
      `INSERT INTO ${target} (${keys.map(identifier).join(", ")}) VALUES ${placeholders}${updates}`,
      values,
    );
    return { data: [], count: result.affectedRows };
  }
  const where = whereClause(table, scopedFilters);
  if (operation === "update") {
    if (!input.values || typeof input.values !== "object" || Array.isArray(input.values)) throw new Error("Invalid update record.");
    const record = input.values as Record<string, unknown>;
    const keys = Object.keys(record);
    keys.forEach((column) => assertColumn(table, column));
    if (!keys.length) return { data: [], count: 0 };
    const target = table === "staff_profiles" ? "users" : identifier(table);
    const result = await execute(
      `UPDATE ${target} SET ${keys.map((key) => `${identifier(key)} = ?`).join(", ")}${where.sql}`,
      [...keys.map((key) => sqlValue(record[key])), ...where.values],
    );
    return { data: [], count: result.affectedRows };
  }
  const result = await execute(`DELETE FROM ${identifier(table)}${where.sql}`, where.values);
  return { data: [], count: result.affectedRows };
}

export async function executeMysqlQueryServer(input: MysqlQueryInput) {
  const result = await runQuery(input);
  return JSON.parse(JSON.stringify(result)) as {
    data: { [key: string]: string | number | boolean | null | object }[];
    count: number | null;
  };
}
