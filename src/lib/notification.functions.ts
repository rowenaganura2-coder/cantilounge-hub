import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireMysqlAuth } from "@/integrations/mysql/auth-middleware";

async function sendOwnerEmail(subject: string, text: string) {
  const host = process.env["SMTP_HOST"];
  const user = process.env["SMTP_USER"];
  const pass = process.env["SMTP_PASS"];
  const recipient = process.env["OWNER_ALERT_EMAIL"];
  if (!host || !user || !pass || !recipient) {
    throw new Error("Email alerts require SMTP_HOST, SMTP_USER, SMTP_PASS, and OWNER_ALERT_EMAIL.");
  }
  const port = Number(process.env["SMTP_PORT"] || 587);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("SMTP_PORT must be a valid TCP port.");
  }
  const { createTransport } = await import("nodemailer");
  const transporter = createTransport({
    host,
    port,
    secure: process.env["SMTP_SECURE"] === "true",
    auth: { user, pass },
  });
  await transporter.sendMail({ from: process.env["SMTP_FROM"] || user, to: recipient, subject, text });
}

type IngredientAlert = {
  id: string;
  name: string;
  unit: string;
  current_stock: number;
  reorder_level: number;
  is_available: boolean;
  expires_at: string | null;
  low_stock_notified_at: string | null;
} & import("mysql2/promise").RowDataPacket;

export const sendLowStockAlerts = createServerFn({ method: "POST" })
  .middleware([requireMysqlAuth])
  .handler(async () => {
    const { execute, queryRows } = await import("@/integrations/mysql/db.server");
    const ingredients = await queryRows<IngredientAlert>(
      "SELECT id, name, unit, current_stock, reorder_level, is_available, expires_at, low_stock_notified_at FROM ingredients",
    );
    const today = new Date();
    const soon = new Date(today);
    soon.setDate(today.getDate() + 7);
    const todayIso = today.toISOString().slice(0, 10);
    const soonIso = soon.toISOString().slice(0, 10);
    const eligible = ingredients.filter((ingredient) => {
      const low = Number(ingredient.current_stock) <= Number(ingredient.reorder_level);
      const expiring = ingredient.expires_at !== null && ingredient.expires_at >= todayIso && ingredient.expires_at <= soonIso;
      const overdue = ingredient.expires_at !== null && ingredient.expires_at < todayIso;
      const notified = ingredient.low_stock_notified_at ? new Date(ingredient.low_stock_notified_at).getTime() : 0;
      return (low || !ingredient.is_available || expiring || overdue) &&
        (!notified || Date.now() - notified > 12 * 60 * 60 * 1000);
    });
    if (eligible.length === 0) return { sent: 0 };
    const body = eligible.map((ingredient) => {
      const stock = `${Number(ingredient.current_stock)} ${ingredient.unit}`;
      const reasons = [
        Number(ingredient.current_stock) <= Number(ingredient.reorder_level)
          ? `low stock (${stock}; reorder at ${Number(ingredient.reorder_level)})`
          : null,
        !ingredient.is_available ? "marked unavailable / 86'd" : null,
        ingredient.expires_at && ingredient.expires_at < todayIso
          ? `expired ${ingredient.expires_at}`
          : ingredient.expires_at && ingredient.expires_at <= soonIso
            ? `expires ${ingredient.expires_at}`
            : null,
      ].filter(Boolean);
      return `- ${ingredient.name}: ${reasons.join(", ")}`;
    }).join("\n");
    await sendOwnerEmail("CantiLounge inventory alert", body);
    for (const ingredient of eligible) {
      await execute("UPDATE ingredients SET low_stock_notified_at = CURRENT_TIMESTAMP(3) WHERE id = ?", [ingredient.id]);
    }
    return { sent: eligible.length };
  });

export const sendVoidAlert = createServerFn({ method: "POST" })
  .middleware([requireMysqlAuth])
  .validator((input) => z.object({ orderId: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    if (!context.roles.some((role) => ["OWNER", "ADMIN", "MANAGER", "CASHIER"].includes(role))) {
      throw new Error("Forbidden");
    }
    const { queryRows } = await import("@/integrations/mysql/db.server");
    const [orders, staff, audits] = await Promise.all([
      queryRows<{ order_number: number; total_amount: number } & import("mysql2/promise").RowDataPacket>(
        "SELECT order_number, total_amount FROM orders WHERE id = ? LIMIT 1",
        [data.orderId],
      ),
      queryRows<{ full_name: string } & import("mysql2/promise").RowDataPacket>(
        "SELECT full_name FROM users WHERE id = ? LIMIT 1",
        [context.userId],
      ),
      queryRows<{ reason: string | null; created_at: string } & import("mysql2/promise").RowDataPacket>(
        "SELECT reason, created_at FROM order_audit_logs WHERE order_id = ? AND action = 'VOID' ORDER BY created_at DESC LIMIT 1",
        [data.orderId],
      ),
    ]);
    const order = orders[0];
    const audit = audits[0];
    if (!order || !audit) throw new Error("Voided order details were not found.");
    await sendOwnerEmail(
      `CantiLounge critical alert: Order #${order.order_number} voided`,
      [
        `Order: #${order.order_number}`,
        `Amount: PHP ${Number(order.total_amount).toFixed(2)}`,
        `Reason: ${audit.reason ?? "Not recorded"}`,
        `Authorized by: ${staff[0]?.full_name ?? "Unknown staff"}`,
        `Time: ${new Date(audit.created_at).toLocaleString("en-PH", { timeZone: "Asia/Manila" })}`,
      ].join("\n"),
    );
    return { sent: true };
  });

export const sendDailySalesReport = createServerFn({ method: "POST" })
  .middleware([requireMysqlAuth])
  .validator((input) =>
    z.object({
      day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => !Number.isNaN(Date.parse(`${value}T00:00:00Z`))),
    }).parse(input),
  )
  .handler(async ({ data, context }) => {
    if (!context.roles.some((role) => role === "OWNER" || role === "ADMIN")) throw new Error("Forbidden");
    const { queryRows } = await import("@/integrations/mysql/db.server");
    const start = new Date(`${data.day}T00:00:00+08:00`);
    const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
    const [orders, voids] = await Promise.all([
      queryRows<{
        total_amount: number;
        payment_method: string;
        cash_received: number;
        gcash_amount: number;
      } & import("mysql2/promise").RowDataPacket>(
        "SELECT total_amount, payment_method, cash_received, gcash_amount FROM orders WHERE settled_at >= ? AND settled_at < ?",
        [start, end],
      ),
      queryRows<{ total: number } & import("mysql2/promise").RowDataPacket>(
        "SELECT COUNT(*) AS total FROM order_audit_logs WHERE action = 'VOID' AND created_at >= ? AND created_at < ?",
        [start, end],
      ),
    ]);
    const gross = orders.reduce((sum, order) => sum + Number(order.total_amount), 0);
    const cash = orders.reduce((sum, order) => sum + Number(order.cash_received), 0);
    const gcash = orders.reduce((sum, order) => sum + Number(order.gcash_amount), 0);
    await sendOwnerEmail(
      `CantiLounge daily X-Read — ${data.day}`,
      [
        `Business date: ${data.day} (Asia/Manila)`,
        `Gross Sales: PHP ${gross.toFixed(2)}`,
        `Cash: PHP ${cash.toFixed(2)}`,
        `GCash: PHP ${gcash.toFixed(2)}`,
        `Total Orders: ${orders.length}`,
        `Voided Tickets: ${Number(voids[0]?.total ?? 0)}`,
      ].join("\n"),
    );
    return { sent: true, orderCount: orders.length };
  });
