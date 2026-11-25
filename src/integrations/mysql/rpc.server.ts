import type { MysqlRole } from "./auth.functions";
import { execute, queryRows, sqlValue, withTransaction } from "./db.server";
import type { PoolConnection, RowDataPacket } from "mysql2/promise";

type RoleRow = { role: MysqlRole } & import("mysql2/promise").RowDataPacket;

async function hasRole(userId: string, role: string) {
  const rows = await queryRows<RoleRow>("SELECT role FROM user_roles WHERE user_id = ?", [userId]);
  return rows.some((item) => item.role === role);
}

function requireRoles(roles: MysqlRole[], allowed: MysqlRole[]) {
  if (!roles.some((role) => allowed.includes(role))) throw new Error("Forbidden");
}

function objectValue(value: unknown, label: string) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} is invalid.`);
  }
  return value as Record<string, unknown>;
}

function orderItems(value: unknown) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 200) {
    throw new Error("An order must contain between 1 and 200 items.");
  }
  return value.map((item) => objectValue(item, "Order item"));
}

async function appendAudit(
  connection: PoolConnection,
  actorId: string,
  actorRole: string,
  action: string,
  entityType: string,
  entityId: string,
  label: string,
  oldValue: unknown,
  newValue: unknown,
) {
  await connection.execute(
    "INSERT INTO audit_logs (id, actor_user_id, actor_role, action_type, entity_type, entity_id, entity_label, old_value, new_value) VALUES (UUID(), ?, ?, ?, ?, ?, ?, ?, ?)",
    [
      actorId,
      actorRole,
      action,
      entityType,
      entityId,
      label,
      sqlValue(oldValue),
      sqlValue(newValue),
    ],
  );
}

async function modifyOrderInTransaction(
  connection: PoolConnection,
  orderId: string,
  itemsInput: unknown,
  actor: { id: string; roles: MysqlRole[] },
) {
  const [orders] = await connection.execute<
    ({ id: string; order_number: number; status: string; total_amount: number; discount_type: string | null; discount_amount: number; settled_at: Date | null } & RowDataPacket)[]
  >(
    "SELECT id, order_number, status, total_amount, discount_type, discount_amount, settled_at FROM orders WHERE id = ? FOR UPDATE",
    [orderId],
  );
  const order = orders[0];
  if (!order) throw new Error("Order not found.");
  if (order.settled_at || ["COMPLETED", "CANCELLED"].includes(order.status)) {
    throw new Error("Only unsettled active orders can be modified.");
  }
  const edits = orderItems(itemsInput);
  const [currentItems] = await connection.execute<
    ({ id: string; menu_item_id: string; name: string; station: string; quantity: number; modifiers: string | null; item_price: number; item_status: string } & RowDataPacket)[]
  >(
    "SELECT id, menu_item_id, name, station, quantity, modifiers, item_price, item_status FROM order_items WHERE order_id = ? FOR UPDATE",
    [orderId],
  );
  const existing = new Map(currentItems.map((item) => [item.id, item]));
  const included = edits.filter((item) => typeof item["id"] === "string").map((item) => String(item["id"]));
  if (
    included.length !== existing.size ||
    new Set(included).size !== included.length ||
    included.some((id) => !existing.has(id))
  ) {
    throw new Error("Ticket changes must include each existing line item exactly once.");
  }

  const before = currentItems.map((item) => ({
    id: item.id,
    menu_item_id: item.menu_item_id,
    quantity: item.quantity,
    modifiers: item.modifiers,
    item_price: item.item_price,
    item_status: item.item_status,
  }));
  for (const edit of edits) {
    const itemId = typeof edit["id"] === "string" ? String(edit["id"]) : null;
    const menuItemId = String(edit["menu_item_id"] ?? "");
    const quantity = Number(edit["quantity"]);
    if (!Number.isInteger(quantity) || quantity < 0 || quantity > 999) {
      throw new Error("Item quantity must be between 0 and 999.");
    }
    const modifiers = edit["modifiers"] ?? null;
    if (itemId) {
      const current = existing.get(itemId);
      if (!current || current.menu_item_id !== menuItemId) throw new Error("Ticket item does not match.");
      const oldQuantity = current.item_status === "CANCELLED" ? 0 : Number(current.quantity);
      await applyRecipeStock(connection, menuItemId, quantity - oldQuantity, orderId, actor.id, "ORDER_EDIT");
      const [menu] = await connection.execute<
        ({ base_price: number } & RowDataPacket)[]
      >("SELECT base_price FROM menu_items WHERE id = ?", [menuItemId]);
      if (!menu[0]) throw new Error("Menu item not found.");
      const price = Number(menu[0].base_price) + getModifierPrice(modifiers);
      const nextStatus = quantity === 0
        ? "CANCELLED"
        : quantity !== oldQuantity || JSON.stringify(parseJson(current.modifiers)) !== JSON.stringify(modifiers)
          ? "PENDING"
          : current.item_status;
      await connection.execute(
        "UPDATE order_items SET quantity = ?, modifiers = ?, item_price = ?, item_status = ? WHERE id = ?",
        [Math.max(1, quantity), sqlValue(modifiers), price, nextStatus, itemId],
      );
    } else if (quantity > 0) {
      const [menu] = await connection.execute<
        ({ id: string; name: string; target_station: string; base_price: number; is_available: number; is_active: number } & RowDataPacket)[]
      >(
        "SELECT id, name, target_station, base_price, is_available, is_active FROM menu_items WHERE id = ?",
        [menuItemId],
      );
      const item = menu[0];
      if (!item || !item.is_available || !item.is_active) throw new Error("Menu item is unavailable.");
      await applyRecipeStock(connection, menuItemId, quantity, orderId, actor.id, "ORDER_EDIT");
      await connection.execute(
        "INSERT INTO order_items (id, order_id, menu_item_id, name, station, quantity, modifiers, item_price, item_status) VALUES (UUID(), ?, ?, ?, ?, ?, ?, ?, 'PENDING')",
        [orderId, menuItemId, item.name, item.target_station, quantity, sqlValue(modifiers), Number(item.base_price) + getModifierPrice(modifiers)],
      );
    }
  }
  const [totals] = await connection.execute<
    ({ subtotal: number; active_count: number; pending_count: number; prep_count: number; ready_count: number } & RowDataPacket)[]
  >(
    "SELECT COALESCE(SUM(item_price * quantity), 0) AS subtotal, COUNT(*) AS active_count, SUM(item_status = 'PENDING') AS pending_count, SUM(item_status = 'IN_PREP') AS prep_count, SUM(item_status IN ('READY','COMPLETED')) AS ready_count FROM order_items WHERE order_id = ? AND item_status <> 'CANCELLED'",
    [orderId],
  );
  const total = Number(totals[0]?.subtotal ?? 0);
  if (total <= 0) throw new Error("Void the entire ticket when no items remain.");
  const discount = discountAmount(order.discount_type, total, Number(order.discount_amount));
  const nextStatus = Number(totals[0]?.pending_count ?? 0) === 0 && Number(totals[0]?.prep_count ?? 0) === 0
    ? "READY"
    : Number(totals[0]?.prep_count ?? 0) > 0 || Number(totals[0]?.ready_count ?? 0) > 0
      ? "IN_PREP"
      : "PENDING";
  await connection.execute(
    "UPDATE orders SET total_amount = ?, discount_amount = ?, status = ? WHERE id = ?",
    [total - discount, discount, nextStatus, orderId],
  );
  const [afterItems] = await connection.execute<RowDataPacket[]>(
    "SELECT id, menu_item_id, quantity, modifiers, item_price, item_status FROM order_items WHERE order_id = ? ORDER BY id",
    [orderId],
  );
  await connection.execute(
    "INSERT INTO order_audit_logs (id, order_id, employee_id, action, before_state, after_state) VALUES (UUID(), ?, ?, 'MODIFY', ?, ?)",
    [
      orderId,
      actor.id,
      JSON.stringify({ items: before, total_amount: Number(order.total_amount) }),
      JSON.stringify({ items: afterItems, total_amount: total - discount }),
    ],
  );
  await appendAudit(
    connection,
    actor.id,
    actor.roles[0] ?? "SYSTEM",
    "ORDER_MODIFY",
    "ORDER",
    orderId,
    `Order #${order.order_number}`,
    { items: before, total_amount: Number(order.total_amount) },
    { items: afterItems, total_amount: total - discount },
  );
}

function parseJson(value: string | null) {
  if (!value) return null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function getModifierPrice(value: unknown) {
  const modifiers = value && typeof value === "object" ? value as Record<string, unknown> : {};
  return modifiers["milk"] === "oat" ? 30 : 0;
}

function discountAmount(type: string | null, subtotal: number, stored: number) {
  if (type === "STUDENT") return Math.round(subtotal * 10) / 100;
  if (type === "SENIOR") return Math.round(subtotal * 20) / 100;
  if (type === "PROMO") return Math.min(subtotal, stored);
  return 0;
}

async function applyRecipeStock(
  connection: PoolConnection,
  menuItemId: string,
  quantityDelta: number,
  orderId: string,
  actorId: string,
  reason: string,
) {
  if (quantityDelta === 0) return;
  const [recipes] = await connection.execute<
    ({ ingredient_id: string; quantity_req: number; current_stock: number; is_available: number } & RowDataPacket)[]
  >(
    "SELECT r.ingredient_id, r.quantity_req, i.current_stock, i.is_available FROM recipe_ingredients r JOIN ingredients i ON i.id = r.ingredient_id WHERE r.menu_item_id = ? FOR UPDATE",
    [menuItemId],
  );
  for (const recipe of recipes) {
    const stockChange = -Number(recipe.quantity_req) * quantityDelta;
    if (quantityDelta > 0 && (!recipe.is_available || Number(recipe.current_stock) < -stockChange)) {
      throw new Error("An ingredient is unavailable or has insufficient stock.");
    }
    await connection.execute(
      "UPDATE ingredients SET current_stock = current_stock + ? WHERE id = ?",
      [stockChange, recipe.ingredient_id],
    );
    await connection.execute(
      "INSERT INTO stock_transactions (id, ingredient_id, `change`, reason, order_id, user_id) VALUES (UUID(), ?, ?, ?, ?, ?)",
      [
        recipe.ingredient_id,
        stockChange,
        quantityDelta > 0 ? reason : reason === "ORDER_VOID" ? "ORDER_VOID" : "ORDER_EDIT_RESTOCK",
        orderId,
        actorId,
      ],
    );
  }
}

async function placeOrder(
  connection: PoolConnection,
  payloadValue: unknown,
  actor: { id: string; roles: MysqlRole[] },
  tableNumber: string | null,
) {
  const payload = objectValue(payloadValue, "Order");
  const clientId = String(payload["client_id"] ?? "");
  const orderType = String(payload["order_type"] ?? "");
  const items = orderItems(payload["items"]);
  if (!/^[\da-f-]{36}$/i.test(clientId)) throw new Error("Invalid client order id.");
  if (!["DINE_IN", "TAKEOUT", "ADVANCE"].includes(orderType)) throw new Error("Invalid order type.");
  if (tableNumber && tableNumber.length > 40) throw new Error("Table number is too long.");
  const [existing] = await connection.execute<
    ({ id: string; order_number: number } & RowDataPacket)[]
  >("SELECT id, order_number FROM orders WHERE client_id = ? LIMIT 1", [clientId]);
  if (existing[0]) {
    if (tableNumber !== null) await connection.execute("UPDATE orders SET table_number = ? WHERE id = ?", [tableNumber, existing[0].id]);
    return { id: existing[0].id, order_number: Number(existing[0].order_number), duplicate: true };
  }
  let subtotal = 0;
  const prepared: {
    menu: { id: string; name: string; target_station: string; base_price: number };
    quantity: number;
    modifiers: unknown;
    price: number;
  }[] = [];
  for (const item of items) {
    const menuId = String(item["menu_item_id"] ?? "");
    const quantity = Number(item["quantity"]);
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 999) throw new Error("Invalid item quantity.");
    const [menus] = await connection.execute<
      ({ id: string; name: string; target_station: string; base_price: number; is_available: number; is_active: number } & RowDataPacket)[]
    >("SELECT id, name, target_station, base_price, is_available, is_active FROM menu_items WHERE id = ?", [menuId]);
    const menu = menus[0];
    if (!menu || !menu.is_available || !menu.is_active) throw new Error("A menu item is unavailable.");
    const modifiers = item["modifiers"] ?? null;
    const price = Number(menu.base_price) + Number(item["modifier_price"] ?? getModifierPrice(modifiers));
    subtotal += price * quantity;
    prepared.push({ menu, quantity, modifiers, price });
  }
  const discountType = String(payload["discount_type"] ?? "") || null;
  const discount = discountAmount(discountType, subtotal, Number(payload["promo_amount"] ?? 0));
  const total = Math.round((subtotal - discount) * 100) / 100;
  const orderId = crypto.randomUUID();
  await connection.execute(
    "INSERT INTO orders (id, client_id, order_type, status, customer_name, table_number, total_amount, discount_type, discount_amount, cashier_id, created_offline, payment_method, cash_received, gcash_amount, gcash_reference, payment_reference, created_at) VALUES (?, ?, ?, 'PENDING', ?, ?, ?, ?, ?, ?, ?, 'UNPAID', 0, 0, NULL, NULL, ?)",
    [
      orderId,
      clientId,
      orderType,
      String(payload["customer_name"] ?? "").trim() || null,
      tableNumber,
      total,
      discountType,
      discount,
      actor.id,
      Boolean(payload["offline"]),
      sqlValue(payload["created_at"] ?? new Date()),
    ],
  );
  const [created] = await connection.execute<
    ({ order_number: number } & RowDataPacket)[]
  >("SELECT order_number FROM orders WHERE id = ?", [orderId]);
  for (const item of prepared) {
    await connection.execute(
      "INSERT INTO order_items (id, order_id, menu_item_id, name, station, quantity, modifiers, item_price, item_status) VALUES (UUID(), ?, ?, ?, ?, ?, ?, ?, 'PENDING')",
      [orderId, item.menu.id, item.menu.name, item.menu.target_station, item.quantity, sqlValue(item.modifiers), item.price],
    );
    await applyRecipeStock(connection, item.menu.id, item.quantity, orderId, actor.id, "SALE");
  }
  return { id: orderId, order_number: Number(created[0]?.order_number ?? 0), duplicate: false };
}

export async function runMysqlRpc(name: string, args: Record<string, unknown>) {
  if (name === "list_login_staff") {
    return queryRows(
      "SELECT id, full_name, staff_code FROM users WHERE is_active = TRUE ORDER BY full_name",
    );
  }
  const { requireStaff } = await import("./auth.server");
  const actor = await requireStaff();
  if (name === "is_staff") return true;
  if (name === "is_manager") return actor.roles.some((role) => ["OWNER", "ADMIN", "MANAGER"].includes(role));
  if (name === "has_role") {
    const userId = String(args["_user_id"] ?? "");
    return userId === actor.id && actor.roles.includes(String(args["_role"]) as MysqlRole);
  }
  if (name === "has_any_role") {
    const userId = String(args["_user_id"] ?? "");
    const roles = Array.isArray(args["_roles"]) ? args["_roles"].map(String) : [];
    return userId === actor.id && roles.some((role) => actor.roles.includes(role as MysqlRole));
  }
  if (name === "record_verified_attendance") {
    const targetUserId = String(args["_user_id"] ?? "");
    const action = String(args["_action"] ?? "");
    const verification = String(args["_verification_method"] ?? "");
    const breakMinutes = Number(args["_break_minutes"] ?? 0);
    const overrideBy = args["_override_by"] ? String(args["_override_by"]) : null;
    if (!["CLOCK_IN", "CLOCK_OUT"].includes(action) || !["FACE_ID", "PIN_OVERRIDE"].includes(verification)) {
      throw new Error("Invalid attendance action.");
    }
    if (!Number.isInteger(breakMinutes) || breakMinutes < 0 || breakMinutes > 240) {
      throw new Error("Break minutes must be between 0 and 240.");
    }
    if (verification === "PIN_OVERRIDE" && (overrideBy !== actor.id || !(await hasRole(actor.id, "ADMIN")))) {
      throw new Error("Only an authenticated admin can authorize a PIN override.");
    }
    return withTransaction(async (connection) => {
      const [users] = await connection.execute<({ id: string } & import("mysql2/promise").RowDataPacket[])>(
        "SELECT id FROM users WHERE id = ? AND is_active = TRUE FOR UPDATE",
        [targetUserId],
      );
      if (!users[0]) throw new Error("Staff member is not active.");
      const [active] = await connection.execute<({ id: string; clock_in: Date } & import("mysql2/promise").RowDataPacket[])>(
        "SELECT id, clock_in FROM attendance_logs WHERE user_id = ? AND clock_out IS NULL ORDER BY clock_in DESC LIMIT 1 FOR UPDATE",
        [targetUserId],
      );
      if (action === "CLOCK_IN") {
        if (active[0]) throw new Error("Already clocked in.");
        await connection.execute(
          "INSERT INTO attendance_logs (id, user_id, verification_method, override_by) VALUES (UUID(), ?, ?, ?)",
          [targetUserId, verification, overrideBy],
        );
          await appendAudit(connection, overrideBy ?? targetUserId, verification === "PIN_OVERRIDE" ? "ADMIN" : "SYSTEM", verification === "PIN_OVERRIDE" ? "STAFF_CLOCK_OVERRIDE" : "STAFF_CLOCK_IN", "ATTENDANCE", targetUserId, "Staff attendance", null, { verification_method: verification });
        return { saved: true };
      }
      if (!active[0]) throw new Error("Not clocked in.");
      const minutes = Math.max(0, Math.floor((Date.now() - new Date(active[0]["clock_in"]).getTime()) / 60000) - breakMinutes);
      await connection.execute(
        "UPDATE attendance_logs SET clock_out = CURRENT_TIMESTAMP(3), break_minutes = ?, total_hours = ?, overtime_min = ?, verification_method = ?, override_by = ? WHERE id = ?",
        [breakMinutes, Math.round((minutes / 60) * 100) / 100, Math.max(0, minutes - 480), verification, overrideBy, active[0]["id"]],
      );
      await appendAudit(connection, overrideBy ?? targetUserId, verification === "PIN_OVERRIDE" ? "ADMIN" : "SYSTEM", verification === "PIN_OVERRIDE" ? "STAFF_CLOCK_OVERRIDE" : "STAFF_CLOCK_OUT", "ATTENDANCE", targetUserId, "Staff attendance", null, { verification_method: verification, clock_out: new Date().toISOString() });
      return { saved: true };
    });
  }
  if (name === "adjust_stock") {
    requireRoles(actor.roles, ["OWNER", "ADMIN", "MANAGER"]);
    const ingredientId = String(args["_ingredient_id"] ?? "");
    const change = Number(args["_change"]);
    const reason = String(args["_reason"] ?? "").trim();
    if (!Number.isFinite(change) || change === 0 || !reason || reason.length > 80) {
      throw new Error("Enter a non-zero stock change and reason.");
    }
    return withTransaction(async (connection) => {
      const [rows] = await connection.execute<
        ({ name: string; current_stock: number } & RowDataPacket)[]
      >("SELECT name, current_stock FROM ingredients WHERE id = ? FOR UPDATE", [ingredientId]);
      const ingredient = rows[0];
      if (!ingredient) throw new Error("Ingredient not found.");
      await connection.execute("UPDATE ingredients SET current_stock = current_stock + ? WHERE id = ?", [change, ingredientId]);
      await connection.execute(
        "INSERT INTO stock_transactions (id, ingredient_id, `change`, reason, user_id) VALUES (UUID(), ?, ?, ?, ?)",
        [ingredientId, change, reason, actor.id],
      );
      await appendAudit(
        connection,
        actor.id,
        actor.roles[0] ?? "SYSTEM",
        reason.toUpperCase().includes("WASTE") ? "WASTE_LOGGED" : "STOCK_ADJUSTED",
        "INGREDIENT",
        ingredientId,
        ingredient.name,
        { current_stock: Number(ingredient.current_stock) },
        { current_stock: Number(ingredient.current_stock) + change, change, reason },
      );
      return null;
    });
  }
  if (name === "place_order" || name === "place_order_with_table") {
    requireRoles(actor.roles, ["OWNER", "ADMIN", "MANAGER", "CASHIER"]);
    const payload = objectValue(args["payload"], "Order");
    const tableNumber = name === "place_order_with_table"
      ? String(payload["table_number"] ?? "").trim() || null
      : null;
    return withTransaction((connection) => placeOrder(connection, payload, actor, tableNumber));
  }
  if (name === "modify_order") {
    requireRoles(actor.roles, ["OWNER", "ADMIN", "MANAGER", "CASHIER"]);
    return withTransaction((connection) =>
      modifyOrderInTransaction(connection, String(args["_order_id"] ?? ""), args["_items"], actor),
    );
  }
  if (name === "update_open_order") {
    requireRoles(actor.roles, ["OWNER", "ADMIN", "MANAGER", "CASHIER"]);
    return withTransaction(async (connection) => {
      const orderId = String(args["_order_id"] ?? "");
      await modifyOrderInTransaction(connection, orderId, args["_items"], actor);
      const [orders] = await connection.execute<
        ({ order_number: number; total_amount: number; discount_type: string | null; discount_amount: number; status: string; settled_at: Date | null } & RowDataPacket)[]
      >("SELECT order_number, total_amount, discount_type, discount_amount, status, settled_at FROM orders WHERE id = ? FOR UPDATE", [orderId]);
      const order = orders[0];
      if (!order || order.settled_at || ["COMPLETED", "CANCELLED"].includes(order.status)) throw new Error("Only unsettled active orders can be modified.");
      const type = String(args["_discount_type"] ?? "") || null;
      if (type && !["STUDENT", "SENIOR"].includes(type)) throw new Error("Select a valid discount.");
      const customer = String(args["_customer_name"] ?? "").trim() || null;
      const table = String(args["_table_number"] ?? "").trim() || null;
      if (customer && customer.length > 120) throw new Error("Customer name is too long.");
      if (table && table.length > 40) throw new Error("Table number is too long.");
      const [items] = await connection.execute<
        ({ subtotal: number } & RowDataPacket)[]
      >("SELECT COALESCE(SUM(item_price * quantity), 0) AS subtotal FROM order_items WHERE order_id = ? AND item_status <> 'CANCELLED'", [orderId]);
      const subtotal = Number(items[0]?.subtotal ?? 0);
      const discount = discountAmount(type, subtotal, 0);
      const orderType = String(args["_order_type"] ?? "");
      if (!["DINE_IN", "TAKEOUT", "ADVANCE"].includes(orderType)) throw new Error("Invalid order type.");
      await connection.execute(
        "UPDATE orders SET customer_name = ?, table_number = ?, order_type = ?, discount_type = ?, discount_amount = ?, total_amount = ? WHERE id = ?",
        [customer, table, orderType, type, discount, subtotal - discount, orderId],
      );
      return null;
    });
  }
  if (name === "mark_order_items_ready") {
    const ids = args["_item_ids"];
    const station = String(args["_station"] ?? "");
    if (!Array.isArray(ids) || ids.length === 0 || !["BARISTA", "KITCHEN"].includes(station)) {
      throw new Error("Select active ticket items.");
    }
    if (!actor.roles.some((role) => ["OWNER", "ADMIN", "MANAGER", "CASHIER"].includes(role)) &&
      !actor.roles.includes(station as MysqlRole)) throw new Error("Forbidden");
    return withTransaction(async (connection) => {
      const placeholders = ids.map(() => "?").join(", ");
      const [result] = await connection.execute(
        `UPDATE order_items SET item_status = 'READY' WHERE id IN (${placeholders}) AND station = ? AND item_status IN ('PENDING','IN_PREP')`,
        [...ids.map(String), station],
      );
      const affected = "affectedRows" in result ? Number(result.affectedRows) : 0;
      if (affected !== ids.length) throw new Error("One or more prep items are no longer active.");
      return null;
    });
  }
  if (name === "settle_order") {
    const orderId = String(args["_order_id"] ?? "");
    const method = String(args["_payment_method"] ?? "");
    const cash = Number(args["_cash_received"] ?? 0);
    const gcash = Number(args["_gcash_amount"] ?? 0);
    const reference = args["_gcash_reference"] ? String(args["_gcash_reference"]) : null;
    const actorId = actor.id;
    if (!["CASH", "GCASH", "SPLIT"].includes(method)) throw new Error("Select a valid payment method.");
    return withTransaction(async (connection) => {
      const [orders] = await connection.execute<({ id: string; total_amount: number; status: string } & import("mysql2/promise").RowDataPacket[])>(
        "SELECT id, total_amount, status FROM orders WHERE id = ? FOR UPDATE",
        [orderId],
      );
      const order = orders[0];
      if (!order || ["COMPLETED", "CANCELLED"].includes(order["status"])) throw new Error("Order cannot be settled.");
      const total = Number(order["total_amount"]);
      if ((method === "CASH" && (cash < total || gcash !== 0)) ||
        (method === "GCASH" && (gcash !== total || cash !== 0)) ||
        (method === "SPLIT" && (cash < 0 || gcash < 0 || Math.round((cash + gcash) * 100) !== Math.round(total * 100)))) {
        throw new Error("Payment amounts do not match the order total.");
      }
      if (reference && !/^\d{4,13}$/.test(reference)) throw new Error("GCash reference is invalid.");
      await connection.execute(
        "UPDATE orders SET payment_method = ?, cash_received = ?, gcash_amount = ?, gcash_reference = ?, payment_reference = ?, settled_at = CURRENT_TIMESTAMP(3), status = 'COMPLETED' WHERE id = ?",
        [method, cash, gcash, reference, reference, orderId],
      );
      await connection.execute(
        "UPDATE order_items SET item_status = 'COMPLETED' WHERE order_id = ? AND item_status <> 'CANCELLED'",
        [orderId],
      );
      await connection.execute(
        "INSERT INTO order_audit_logs (id, order_id, employee_id, action, before_state, after_state) VALUES (UUID(), ?, ?, 'SETTLE', JSON_OBJECT('status', ?), JSON_OBJECT('payment_method', ?))",
        [orderId, actorId, order["status"], method],
      );
      await appendAudit(
        connection,
        actor.id,
        actor.roles[0] ?? "SYSTEM",
        "ORDER_SETTLED",
        "ORDER",
        orderId,
        `Order #${orderId}`,
        { status: order["status"], settled_at: null },
        { status: "COMPLETED", payment_method: method, cash_received: cash, gcash_amount: gcash },
      );
      return null;
    });
  }
  if (name === "get_income_analytics") {
    if (!actor.roles.includes("ADMIN") && !actor.roles.includes("OWNER")) throw new Error("Forbidden");
    const start = args["_start"];
    const end = args["_end"];
    return queryRows(
      "SELECT DATE(settled_at) AS day, COUNT(*) AS order_count, SUM(total_amount) AS revenue FROM orders WHERE settled_at >= ? AND settled_at < ? AND status = 'COMPLETED' GROUP BY DATE(settled_at) ORDER BY day",
      [sqlValue(start), sqlValue(end)],
    );
  }
  if (name === "complete_order") {
    if (!actor.roles.some((role) => ["OWNER", "ADMIN", "MANAGER", "CASHIER"].includes(role))) throw new Error("Forbidden");
    const id = String(args["_order_id"] ?? "");
    await execute("UPDATE orders SET status = 'COMPLETED' WHERE id = ? AND status <> 'CANCELLED'", [id]);
    return null;
  }
  if (name === "void_order") {
    if (!actor.roles.some((role) => ["OWNER", "ADMIN", "MANAGER", "CASHIER"].includes(role))) throw new Error("Forbidden");
    const id = String(args["_order_id"] ?? "");
    const reason = String(args["_reason"] ?? "").trim();
    if (!reason) throw new Error("A void reason is required.");
    return withTransaction(async (connection) => {
      const [orders] = await connection.execute<({ id: string; order_number: number; status: string; settled_at: Date | null; total_amount: number } & RowDataPacket[])>(
        "SELECT id, order_number, status, settled_at, total_amount FROM orders WHERE id = ? FOR UPDATE",
        [id],
      );
      const order = orders[0];
      if (!order || order["settled_at"] || ["COMPLETED", "CANCELLED"].includes(order["status"])) {
        throw new Error("Only unsettled active orders can be voided.");
      }
      const [items] = await connection.execute<
        ({ menu_item_id: string; quantity: number; item_status: string } & RowDataPacket)[]
      >("SELECT menu_item_id, quantity, item_status FROM order_items WHERE order_id = ? FOR UPDATE", [id]);
      for (const item of items) {
        if (item.item_status !== "CANCELLED") {
          await applyRecipeStock(connection, item.menu_item_id, -Number(item.quantity), id, actor.id, "ORDER_VOID");
        }
      }
      await connection.execute("UPDATE order_items SET item_status = 'CANCELLED' WHERE order_id = ?", [id]);
      await connection.execute("UPDATE orders SET status = 'CANCELLED' WHERE id = ?", [id]);
      await connection.execute(
        "INSERT INTO order_audit_logs (id, order_id, employee_id, action, reason, before_state, after_state) VALUES (UUID(), ?, ?, 'VOID', ?, JSON_OBJECT('status', ?), JSON_OBJECT('status', 'CANCELLED'))",
        [id, actor.id, reason, order["status"]],
      );
      await connection.execute(
        "INSERT INTO audit_logs (id, actor_user_id, actor_role, action_type, entity_type, entity_id, entity_label, old_value, new_value) VALUES (UUID(), ?, ?, 'ORDER_VOIDED', 'ORDER', ?, ?, JSON_OBJECT('status', ?), JSON_OBJECT('reason', ?))",
        [actor.id, actor.roles[0] ?? "SYSTEM", id, `Order #${order["order_number"]}`, order["status"], reason],
      );
      return null;
    });
  }
  throw new Error(`MySQL operation is not implemented: ${name}`);
}

