import { createFileRoute, redirect, useNavigate } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Component, useMemo, useState, type ReactNode } from "react";
import { ReceiptText } from "lucide-react";
import { mysql } from "@/integrations/mysql/client";
import type { Database } from "@/integrations/mysql/types";
import { peso } from "@/lib/staff-auth";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { TicketEditor } from "@/routes/_authenticated/pos";
import { sendDailySalesReport, sendVoidAlert } from "@/lib/notification.functions";

type Order = Database["public"]["Tables"]["orders"]["Row"];
type OrderItem = Database["public"]["Tables"]["order_items"]["Row"];
type OrderStatus = Order["status"];
const EMPTY_ORDERS: Order[] = [];

function formatModifiers(modifiers: OrderItem["modifiers"]) {
  if (!modifiers || typeof modifiers !== "object" || Array.isArray(modifiers)) return "";
  return Object.entries(modifiers)
    .filter(([, value]) => typeof value === "string" && value !== "none")
    .map(([key, value]) => `${key}: ${value}`)
    .join(" · ");
}

function numberOrZero(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function isMissingRpc(message: string, functionName: string) {
  const normalizedMessage = message.toLowerCase();
  return (
    message.includes("PGRST202") ||
    (normalizedMessage.includes("schema cache") &&
      normalizedMessage.includes(functionName.toLowerCase())) ||
    (normalizedMessage.includes("could not find the function") &&
      normalizedMessage.includes(functionName.toLowerCase()))
  );
}

const statusStyles: Record<OrderStatus, string> = {
  PENDING: "border-amber-400/30 bg-amber-400/10 text-amber-200",
  IN_PREP: "border-sky-400/30 bg-sky-400/10 text-sky-200",
  READY: "border-[#10B981]/30 bg-[#10B981]/10 text-[#10B981]",
  COMPLETED: "border-[#EAE2D8]/30 bg-[#EAE2D8]/10 text-[#EAE2D8]",
  CANCELLED: "border-rose-400/30 bg-rose-400/10 text-rose-200",
};

function manilaDayBounds(day: string) {
  const start = new Date(`${day}T00:00:00+08:00`);
  return {
    start: start.toISOString(),
    end: new Date(start.getTime() + 24 * 60 * 60 * 1000).toISOString(),
  };
}

function currentManilaDay() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Manila",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values["year"]}-${values["month"]}-${values["day"]}`;
}

export const Route = createFileRoute("/_authenticated/orders")({
  beforeLoad: ({ context }) => {
    if (!context.staff.roles.some((role) => ["ADMIN", "MANAGER", "CASHIER"].includes(role))) {
      throw redirect({ to: "/pos" });
    }
  },
  head: () => ({
    meta: [
      { title: "Order History — CantiLounge Hub" },
      { name: "description", content: "Browse previous Cantilounge orders and receipts." },
    ],
  }),
  component: OrdersRoute,
});

class OrdersErrorBoundary extends Component<{ children: ReactNode }, { hasError: boolean }> {
  override state = { hasError: false };

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  override componentDidCatch(error: Error) {
    console.error("Orders view failed to render", error);
  }

  override render() {
    if (this.state.hasError) {
      return (
        <div className="grid min-h-screen place-items-center bg-[#1A120F] px-4 text-[#FAF0E6]">
          <div className="max-w-md rounded-2xl border border-[#332017] bg-[#1C120E] p-6 text-center">
            <h1 className="font-display text-2xl">Orders could not be displayed</h1>
            <p className="mt-2 text-sm text-[#C8B6A6]">
              The rest of the app is still available. Try loading the Orders view again.
            </p>
            <button
              type="button"
              onClick={() => this.setState({ hasError: false })}
              className="mt-5 rounded-lg bg-[#B85D19] px-4 py-2 text-sm font-semibold text-white hover:bg-[#9F4E16]"
            >
              Try again
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

function OrdersRoute() {
  return (
    <OrdersErrorBoundary>
      <OrderHistoryPage />
    </OrdersErrorBoundary>
  );
}

function OrderHistoryPage() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { staff } = Route.useRouteContext();
  const emailReport = useServerFn(sendDailySalesReport);
  const notifyVoid = useServerFn(sendVoidAlert);
  const [selectedOrder, setSelectedOrder] = useState<Order | null>(null);
  const [selectedDay, setSelectedDay] = useState(() => currentManilaDay());
  const [editingOrder, setEditingOrder] = useState<Order | null>(null);
  const [voidingOrder, setVoidingOrder] = useState<Order | null>(null);
  const [voidReason, setVoidReason] = useState("");
  const [savingVoid, setSavingVoid] = useState(false);
  const [sendingReport, setSendingReport] = useState(false);
  const [showVoidedOrders, setShowVoidedOrders] = useState(false);
  const dayBounds = useMemo(() => manilaDayBounds(selectedDay), [selectedDay]);
  const {
    data: orderData,
    isLoading,
    isError,
  } = useQuery({
    queryKey: ["order-history", selectedDay],
    queryFn: async () => {
      const { data, error } = await mysql
        .from("orders")
        .select("*")
        .gte("created_at", dayBounds.start)
        .lt("created_at", dayBounds.end)
        .order("created_at", { ascending: true });
      if (error) throw error;
      return data ?? [];
    },
  });
  const orders = orderData ?? EMPTY_ORDERS;
  const {
    data: settledOrderData,
    isError: settledOrdersError,
    isLoading: settledOrdersLoading,
  } = useQuery({
    queryKey: ["order-history-settled-orders", selectedDay],
    queryFn: async () => {
      const { data, error } = await mysql
        .from("orders")
        .select("*")
        .eq("status", "COMPLETED")
        .not("settled_at", "is", null)
        .gte("settled_at", dayBounds.start)
        .lt("settled_at", dayBounds.end);
      if (error) throw error;
      return data ?? [];
    },
  });
  const {
    data: dailyAuditEvents,
    isError: dailyAuditError,
    isLoading: dailyAuditLoading,
  } = useQuery({
    queryKey: ["order-history-daily-events", selectedDay],
    queryFn: async () => {
      const { data, error } = await mysql
        .from("order_audit_logs")
        .select("order_id, employee_id, action, created_at")
        .in("action", ["SETTLE", "VOID"])
        .gte("created_at", dayBounds.start)
        .lt("created_at", dayBounds.end)
        .order("created_at", { ascending: true });
      if (error) throw error;
      return data ?? [];
    },
  });
  const dailyAuditOrderIds = useMemo(
    () => [...new Set((dailyAuditEvents ?? []).map((event) => event.order_id))],
    [dailyAuditEvents],
  );
  const {
    data: dailyActivityOrders,
    isError: dailyActivityOrdersError,
    isLoading: dailyActivityOrdersLoading,
  } = useQuery({
    queryKey: ["order-history-daily-activity-orders", dailyAuditOrderIds.join(",")],
    enabled: dailyAuditOrderIds.length > 0,
    queryFn: async () => {
      const { data, error } = await mysql.from("orders").select("*").in("id", dailyAuditOrderIds);
      if (error) throw error;
      return data ?? [];
    },
  });
  const cashierIds = useMemo(
    () => [...new Set((dailyAuditEvents ?? []).map((event) => event.employee_id))],
    [dailyAuditEvents],
  );
  const { data: cashiers, isError: cashiersError } = useQuery({
    queryKey: ["order-history-cashiers", cashierIds.join(",")],
    enabled: cashierIds.length > 0,
    queryFn: async () => {
      const { data, error } = await mysql
        .from("staff_profiles")
        .select("id, full_name")
        .in("id", cashierIds);
      if (error) throw error;
      return data ?? [];
    },
  });
  const cashierNameById = useMemo(
    () => new Map((cashiers ?? []).map((cashier) => [cashier.id, cashier.full_name])),
    [cashiers],
  );
  const safeOrders = useMemo(
    () => (orders ?? []).filter((order): order is Order => Boolean(order?.id && order?.created_at)),
    [orders],
  );
  const safeDailyActivityOrders = useMemo(
    () =>
      (dailyActivityOrders ?? []).filter((order): order is Order =>
        Boolean(order?.id && order?.created_at),
      ),
    [dailyActivityOrders],
  );
  const safeSettledOrders = useMemo(
    () => (settledOrderData ?? []).map((order): Order => order),
    [settledOrderData],
  );
  const dailyActivityByOrder = useMemo(
    () =>
      new Map(
        [...safeOrders, ...safeDailyActivityOrders, ...safeSettledOrders].map((order) => [
          order.id,
          order,
        ]),
      ),
    [safeDailyActivityOrders, safeOrders, safeSettledOrders],
  );
  const dailySalesEvents = useMemo(() => {
    const events = (dailyAuditEvents ?? []).map((event) => ({
      order_id: event.order_id,
      employee_id: event.employee_id,
      action: event.action as "SETTLE" | "VOID",
      created_at: event.created_at,
    }));
    const existing = new Set(events.map((event) => `${event.order_id}:${event.action}`));
    for (const order of dailyActivityByOrder.values()) {
      const settledAt = order.settled_at;
      if (
        settledAt &&
        settledAt >= dayBounds.start &&
        settledAt < dayBounds.end &&
        !existing.has(`${order.id}:SETTLE`)
      ) {
        events.push({
          order_id: order.id,
          employee_id: order.cashier_id,
          action: "SETTLE",
          created_at: settledAt,
        });
      }
      if (
        order.status === "CANCELLED" &&
        order.created_at >= dayBounds.start &&
        order.created_at < dayBounds.end &&
        !existing.has(`${order.id}:VOID`)
      ) {
        events.push({
          order_id: order.id,
          employee_id: order.cashier_id,
          action: "VOID",
          created_at: order.created_at,
        });
      }
    }
    return events;
  }, [dailyActivityByOrder, dailyAuditEvents, dayBounds.end, dayBounds.start]);
  const dailyEventTimeByOrder = useMemo(
    () => new Map(dailySalesEvents.map((event) => [event.order_id, event.created_at])),
    [dailySalesEvents],
  );
  const dailyOrders = useMemo(() => {
    const merged = new Map<string, Order>();
    for (const order of safeOrders) merged.set(order.id, order);
    for (const order of safeDailyActivityOrders) merged.set(order.id, order);
    for (const order of safeSettledOrders) merged.set(order.id, order);
    return [...merged.values()].sort((a, b) => {
      const aTime = dailyEventTimeByOrder.get(a.id) ?? a.created_at;
      const bTime = dailyEventTimeByOrder.get(b.id) ?? b.created_at;
      return aTime.localeCompare(bTime);
    });
  }, [dailyEventTimeByOrder, safeDailyActivityOrders, safeOrders, safeSettledOrders]);
  const voidedOrderCount = dailyOrders.filter((order) => order.status === "CANCELLED").length;
  const visibleOrders = showVoidedOrders
    ? dailyOrders
    : dailyOrders.filter((order) => order.status !== "CANCELLED");
  const hasOrderListError = isError;
  const orderIds = useMemo(() => dailyOrders.map((order) => order.id), [dailyOrders]);
  const {
    data: dailyItems,
    isError: dailyItemsError,
    isLoading: dailyItemsLoading,
  } = useQuery({
    queryKey: ["order-history-daily-items", orderIds.join(",")],
    enabled: orderIds.length > 0,
    queryFn: async () => {
      const { data, error } = await mysql
        .from("order_items")
        .select("id, order_id, name, quantity, item_price, modifiers, item_status")
        .in("order_id", orderIds);
      if (error) throw error;
      return data ?? [];
    },
  });
  const dailyItemsByOrder = useMemo(() => {
    const grouped = new Map<string, NonNullable<typeof dailyItems>>();
    for (const item of dailyItems ?? []) {
      if (!item?.order_id) continue;
      const group = grouped.get(item.order_id) ?? [];
      group.push(item);
      grouped.set(item.order_id, group);
    }
    return grouped;
  }, [dailyItems]);
  const dailySummary = useMemo(() => {
    const paidEvents = dailySalesEvents.filter((event) => event.action === "SETTLE");
    const voidEvents = dailySalesEvents.filter((event) => event.action === "VOID");
    const paidOrders = new Map(
      safeSettledOrders
        .filter((order) => order.status === "COMPLETED" && order.settled_at)
        .map((order) => [order.id, order]),
    );
    for (const event of paidEvents) {
      const order = dailyActivityByOrder.get(event.order_id);
      if (order?.status === "COMPLETED") paidOrders.set(order.id, order);
    }
    const paid = [...paidOrders.values()];
    const voided = voidEvents
      .map((event) => dailyActivityByOrder.get(event.order_id))
      .filter((order): order is NonNullable<typeof order> => Boolean(order));
    return {
      gross: paid.reduce((sum, order) => sum + numberOrZero(order?.total_amount), 0),
      cash: paid.reduce((sum, order) => {
        if (order?.payment_method === "CASH") {
          return sum + numberOrZero(order?.total_amount);
        }
        if (order.payment_method === "SPLIT") {
          return (
            sum + Math.max(0, numberOrZero(order?.total_amount) - numberOrZero(order?.gcash_amount))
          );
        }
        return sum;
      }, 0),
      gcash: paid.reduce((sum, order) => sum + numberOrZero(order?.gcash_amount), 0),
      discounts: paid.reduce((sum, order) => sum + numberOrZero(order?.discount_amount), 0),
      voidedValue: voided.reduce((sum, order) => sum + numberOrZero(order?.total_amount), 0),
      paidCount: paid.length,
      voidedCount: voidEvents.length,
    };
  }, [dailyActivityByOrder, dailySalesEvents, safeSettledOrders]);
  const shiftTotals = useMemo(() => {
    const totals = new Map<
      string,
      { cashierId: string; count: number; sales: number; voidCount: number; voidValue: number }
    >();
    for (const event of dailySalesEvents) {
      const order = dailyActivityByOrder.get(event.order_id);
      if (!order) continue;
      const shift = totals.get(event.employee_id) ?? {
        cashierId: event.employee_id,
        count: 0,
        sales: 0,
        voidCount: 0,
        voidValue: 0,
      };
      if (event.action === "SETTLE") {
        shift.count += 1;
        shift.sales += numberOrZero(order?.total_amount);
      }
      if (event.action === "VOID") {
        shift.voidCount += 1;
        shift.voidValue += numberOrZero(order?.total_amount);
      }
      totals.set(event.employee_id, shift);
    }
    return [...totals.values()].sort((a, b) => b.sales - a.sales);
  }, [dailyActivityByOrder, dailySalesEvents]);

  const {
    data: items,
    isLoading: itemsLoading,
    isError: itemsError,
  } = useQuery({
    queryKey: ["order-history-items", selectedOrder?.id],
    enabled: !!selectedOrder,
    queryFn: async () => {
      if (!selectedOrder) return [];
      const { data, error } = await mysql
        .from("order_items")
        .select("id, name, quantity, item_price, modifiers, item_status")
        .eq("order_id", selectedOrder.id);
      if (error) throw error;
      return (data ?? []) as Pick<
        OrderItem,
        "id" | "name" | "quantity" | "item_price" | "modifiers" | "item_status"
      >[];
    },
  });
  const activeItems = items?.filter((item) => item?.id && item.item_status !== "CANCELLED") ?? [];
  const removedItemCount =
    items?.filter((item) => item?.id && item.item_status === "CANCELLED").length ?? 0;

  const {
    data: auditLogs,
    isLoading: auditLoading,
    isError: auditError,
  } = useQuery({
    queryKey: ["order-audit", selectedOrder?.id],
    enabled: !!selectedOrder,
    queryFn: async () => {
      if (!selectedOrder) return [];
      const { data, error } = await mysql
        .from("order_audit_logs")
        .select("id, action, reason, created_at, employee_id")
        .eq("order_id", selectedOrder.id)
        .order("created_at", { ascending: false });
      if (error) throw error;
      return data ?? [];
    },
  });

  const voidTicket = async () => {
    if (!voidingOrder || !voidReason) return;
    setSavingVoid(true);
    try {
      const { error } = await mysql.rpc("void_order", {
        _order_id: voidingOrder.id,
        _reason: voidReason,
      });
      if (error) throw error;
      void notifyVoid({ data: { orderId: voidingOrder.id } }).catch((notificationError: unknown) =>
        toast.error(
          `Ticket voided, but owner email alert failed: ${notificationError instanceof Error ? notificationError.message : String(notificationError)}`,
        ),
      );
      toast.success(`Order #${voidingOrder.order_number} voided`);
      const markVoided = (orders: Order[] | undefined) =>
        orders?.map((order) =>
          order.id === voidingOrder.id ? { ...order, status: "CANCELLED" as const } : order,
        );
      qc.setQueriesData<Order[]>({ queryKey: ["order-history"] }, markVoided);
      qc.setQueriesData<Order[]>({ queryKey: ["order-history-daily-activity-orders"] }, markVoided);
      await Promise.all([
        qc.invalidateQueries({ queryKey: ["order-history"] }),
        qc.invalidateQueries({ queryKey: ["order-history-settled-orders"] }),
        qc.invalidateQueries({ queryKey: ["order-history-daily-events"] }),
        qc.invalidateQueries({ queryKey: ["order-history-daily-activity-orders"] }),
      ]);
      setVoidingOrder(null);
      setSelectedOrder(null);
      setVoidReason("");
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : error &&
              typeof error === "object" &&
              "message" in error &&
              typeof error.message === "string"
            ? error.message
            : "Unknown database error";
      toast.error(
        isMissingRpc(message, "void_order")
          ? "Could not void this order because the void_order database function is missing. Apply the Orders migrations and retry."
          : `Could not void this order: ${message}`,
      );
    } finally {
      setSavingVoid(false);
    }
  };

  const sendReport = async () => {
    setSendingReport(true);
    try {
      await emailReport({ data: { day: selectedDay } });
      toast.success(`Daily X-Read emailed for ${selectedDay}`);
    } catch (error) {
      toast.error(
        `Could not send daily report: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      setSendingReport(false);
    }
  };

  return (
    <div className="min-h-screen bg-[radial-gradient(circle_at_top,_rgba(212,163,115,0.13),_transparent_36%),#1A120F] p-4 text-[#FAF0E6] sm:p-6 lg:p-8">
      <div className="mx-auto max-w-7xl">
        <header className="mb-7">
          <p className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.24em] text-[#D4A373]">
            <ReceiptText className="size-4" />
            Sales
          </p>
          <h1 className="font-display text-4xl text-[#FAF0E6] sm:text-5xl">Order History</h1>
          <p className="mt-2 text-sm text-[#C8B6A6]">
            Daily sales, tender reconciliation, shift totals, and open-ticket history.
          </p>
        </header>

        <section className="mb-6 space-y-4">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <h2 className="font-display text-2xl text-[#FAF0E6]">Daily sales summary</h2>
              <p className="mt-1 text-xs text-[#A98D7D]">Day boundary uses Asia/Manila time.</p>
            </div>
            <div className="flex flex-wrap items-end gap-3">
              <label className="space-y-1 text-xs text-[#C8B6A6]">
                <span className="block uppercase tracking-[0.14em]">Sales date</span>
                <input
                  type="date"
                  value={selectedDay}
                  onChange={(event) => setSelectedDay(event.target.value || currentManilaDay())}
                  className="h-10 rounded-lg border border-[#4A3831] bg-[#1C120E] px-3 text-sm text-[#FAF0E6] [color-scheme:dark]"
                />
              </label>
              {staff.roles.includes("ADMIN") && (
                <Button
                  type="button"
                  disabled={sendingReport}
                  onClick={() => void sendReport()}
                  className="h-10 bg-[#B85D19] text-white hover:bg-[#A34F15]"
                >
                  {sendingReport ? "Sending…" : "Send Daily Report"}
                </Button>
              )}
            </div>
          </div>
          {dailyAuditLoading || dailyActivityOrdersLoading || settledOrdersLoading ? (
            <p className="text-sm text-[#C8B6A6]">Calculating daily totals…</p>
          ) : (
            <>
              {(dailyAuditError || dailyActivityOrdersError || settledOrdersError) && (
                <p
                  role="status"
                  className="rounded-xl border border-amber-400/25 bg-amber-950/20 p-4 text-sm text-amber-100"
                >
                  Some payment or audit details could not be loaded. Totals below use the order
                  records available for this date; apply the latest Supabase migrations for full
                  reconciliation.
                </p>
              )}
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
                {[
                  { label: "Gross sales collected", value: peso(dailySummary.gross) },
                  { label: "Orders completed", value: `${dailySummary.paidCount} orders` },
                  { label: "Cash collected", value: peso(dailySummary.cash) },
                  { label: "GCash collected", value: peso(dailySummary.gcash) },
                  { label: "Discounts given", value: peso(dailySummary.discounts) },
                ].map((metric) => (
                  <div
                    key={metric.label}
                    className="rounded-2xl border border-[#3A261D] bg-[#1C120E]/90 p-4"
                  >
                    <p className="text-[10px] uppercase tracking-[0.15em] text-[#A98D7D]">
                      {metric.label}
                    </p>
                    <p className="mt-2 font-mono text-xl font-semibold text-[#E9B988]">
                      {metric.value}
                    </p>
                  </div>
                ))}
              </div>
              <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_2fr]">
                <div className="rounded-2xl border border-rose-400/20 bg-[#1C120E] p-4">
                  <p className="text-[10px] uppercase tracking-[0.15em] text-[#A98D7D]">
                    Voided / cancelled
                  </p>
                  <p className="mt-2 font-mono text-xl font-semibold text-rose-200">
                    {dailySummary.voidedCount} orders · {peso(dailySummary.voidedValue)}
                  </p>
                </div>
                <div className="rounded-2xl border border-[#3A261D] bg-[#1C120E]/90 p-4">
                  <h3 className="text-[10px] uppercase tracking-[0.15em] text-[#A98D7D]">
                    Cashier shift totals
                  </h3>
                  {cashiersError && (
                    <p role="alert" className="mt-2 text-xs text-rose-200">
                      Cashier names could not be loaded; totals are still grouped by staff ID.
                    </p>
                  )}
                  {shiftTotals.length ? (
                    <div className="mt-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
                      {shiftTotals.map((shift) => (
                        <div
                          key={shift.cashierId}
                          className="rounded-xl border border-[#442E24] bg-[#120B09]/50 p-3 text-sm"
                        >
                          <p className="truncate font-semibold text-[#FAF0E6]">
                            {cashierNameById.get(shift.cashierId) ?? "Staff member"}
                          </p>
                          <p className="mt-1 font-mono text-[#E9B988]">{peso(shift.sales)}</p>
                          <p className="mt-1 text-xs text-[#A98D7D]">
                            {shift.count} paid · {shift.voidCount} voided
                            {shift.voidCount ? ` · ${peso(shift.voidValue)} voided` : ""}
                          </p>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="mt-3 text-sm text-[#A98D7D]">
                      No cashier activity for this date.
                    </p>
                  )}
                </div>
              </div>
            </>
          )}
        </section>

        <section className="overflow-hidden rounded-3xl border border-[#4A3831] bg-[#1D130E]/85 shadow-[0_24px_60px_rgba(0,0,0,0.2)] backdrop-blur-xl">
          <div className="flex items-end justify-between gap-3 border-b border-[#4A3831] p-4 sm:p-6">
            <div>
              <h2 className="font-display text-2xl text-[#FAF0E6]">Orders for {selectedDay}</h2>
              <p className="mt-1 text-xs text-[#C8B6A6]">Chronological · paid and unpaid tickets</p>
            </div>
            <div className="flex items-center gap-3">
              <span className="text-xs text-[#8B7367]">{visibleOrders.length} orders</span>
              {voidedOrderCount > 0 && (
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setShowVoidedOrders((shown) => !shown)}
                  className="h-9 border-[#4A3831] text-xs text-[#C8B6A6]"
                >
                  {showVoidedOrders ? "Hide" : "Show"} voided ({voidedOrderCount})
                </Button>
              )}
            </div>
          </div>

          {hasOrderListError ? (
            <p role="alert" className="p-6 text-sm text-rose-200">
              Could not load order history. Please try again.
            </p>
          ) : isLoading || dailyAuditLoading || dailyActivityOrdersLoading ? (
            <p className="p-6 text-sm text-[#C8B6A6]">Loading previous orders…</p>
          ) : visibleOrders.length ? (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[1050px] text-left text-sm">
                <thead className="bg-[#241712]/80 text-[10px] uppercase tracking-[0.16em] text-[#C8B6A6]">
                  <tr>
                    <th className="px-5 py-3 font-semibold">Order</th>
                    <th className="px-5 py-3 font-semibold">Time</th>
                    <th className="px-5 py-3 font-semibold">Customer / table</th>
                    <th className="px-5 py-3 font-semibold">Items</th>
                    <th className="px-5 py-3 font-semibold">Payment</th>
                    <th className="px-5 py-3 font-semibold">Type</th>
                    <th className="px-5 py-3 font-semibold">Status</th>
                    <th className="px-5 py-3 text-right font-semibold">Total</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleOrders
                    .filter((order) => order?.id)
                    .map((order) => (
                      <tr
                        key={order.id}
                        tabIndex={0}
                        role="button"
                        onClick={() => setSelectedOrder(order)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter" || event.key === " ") {
                            event.preventDefault();
                            setSelectedOrder(order);
                          }
                        }}
                        className="cursor-pointer border-t border-[#3E2C24] transition hover:bg-[#2A1C16]/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#D4A373]"
                      >
                        <td className="px-5 py-3 font-mono font-semibold text-[#E9B988]">
                          #{order?.order_number ?? "—"}
                        </td>
                        <td className="whitespace-nowrap px-5 py-3 text-[#C8B6A6]">
                          {new Intl.DateTimeFormat("en-PH", {
                            timeZone: "Asia/Manila",
                            timeStyle: "short",
                          }).format(
                            new Date(
                              dailyEventTimeByOrder.get(order?.id ?? "") ?? order?.created_at ?? "",
                            ),
                          )}
                        </td>
                        <td className="max-w-48 truncate px-5 py-3 text-[#FAF0E6]">
                          {[
                            order?.customer_name,
                            order?.table_number ? `Table ${order.table_number}` : null,
                          ]
                            .filter(Boolean)
                            .join(" · ") || "Walk-in"}
                        </td>
                        <td className="max-w-60 px-5 py-3 text-xs text-[#C8B6A6]">
                          <span className="line-clamp-2">
                            {dailyItemsError
                              ? "Item details unavailable"
                              : dailyItemsLoading
                                ? "Loading item details…"
                                : (dailyItemsByOrder.get(order?.id ?? "") ?? [])
                                    .filter((item) => item?.id && item.item_status !== "CANCELLED")
                                    .map(
                                      (item) => `${item?.quantity ?? 0}× ${item?.name ?? "Item"}`,
                                    )
                                    .join(", ") || "No active items"}
                          </span>
                        </td>
                        <td className="px-5 py-3">
                          <span className="rounded-full border border-[#D4A373]/25 bg-[#D4A373]/10 px-2 py-1 text-[10px] font-semibold text-[#E9B988]">
                            {order?.settled_at
                              ? order?.payment_method === "GCASH"
                                ? "GCash"
                                : (order?.payment_method ?? "Paid")
                              : "Unpaid"}
                          </span>
                          {(order?.payment_reference || order?.gcash_reference) && (
                            <span className="mt-1 block font-mono text-[10px] text-[#A98D7D]">
                              Ref {order?.payment_reference || order?.gcash_reference}
                            </span>
                          )}
                        </td>
                        <td className="px-5 py-3 text-[#C8B6A6]">
                          {order?.order_type?.replace?.("_", " ") ?? "Unknown"}
                        </td>
                        <td className="px-5 py-3">
                          <span
                            className={`rounded-full border px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.12em] ${order?.status ? statusStyles[order.status] : "border-[#4A3831] bg-[#241712] text-[#C8B6A6]"}`}
                          >
                            {order?.status === "CANCELLED"
                              ? "Void"
                              : order?.settled_at
                                ? "Paid"
                                : "Unpaid"}
                          </span>
                        </td>
                        <td className="px-5 py-3 text-right font-mono font-semibold text-[#FAF0E6]">
                          {peso(Number(order?.total_amount ?? 0))}
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="p-10 text-center text-sm text-[#C8B6A6]">
              {showVoidedOrders
                ? "No orders have been placed yet."
                : voidedOrderCount
                  ? "No active orders. Voided tickets are hidden."
                  : "No orders have been placed yet."}
            </p>
          )}
        </section>
      </div>

      <Dialog open={!!selectedOrder} onOpenChange={(open) => !open && setSelectedOrder(null)}>
        <DialogContent className="max-h-[85vh] overflow-y-auto border-[#4A3831] bg-[#1D130E]/95 text-[#FAF0E6] backdrop-blur-xl sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="font-display text-2xl text-[#FAF0E6]">
              Order #{selectedOrder?.order_number}
            </DialogTitle>
          </DialogHeader>
          {selectedOrder && (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-3 rounded-xl border border-[#442E24] bg-[#120B09]/60 p-3 text-sm">
                <div>
                  <p className="text-xs text-[#8B7367]">Date</p>
                  <p className="mt-1 text-[#FAF0E6]">
                    {new Intl.DateTimeFormat("en-PH", {
                      timeZone: "Asia/Manila",
                      dateStyle: "medium",
                      timeStyle: "short",
                    }).format(new Date(selectedOrder?.created_at ?? ""))}
                  </p>
                </div>
                <div>
                  <p className="text-xs text-[#8B7367]">Customer</p>
                  <p className="mt-1 text-[#FAF0E6]">
                    {selectedOrder?.customer_name || "Walk-in"}
                    {selectedOrder?.table_number ? ` · Table ${selectedOrder.table_number}` : ""}
                  </p>
                </div>
                <div>
                  <p className="text-xs text-[#8B7367]">Type</p>
                  <p className="mt-1 text-[#FAF0E6]">
                    {selectedOrder?.order_type?.replace?.("_", " ") ?? "Unknown"}
                  </p>
                </div>
                <div>
                  <p className="text-xs text-[#8B7367]">Status</p>
                  <p className="mt-1 text-[#FAF0E6]">
                    {selectedOrder?.status?.replace?.("_", " ") ?? "Unknown"}
                  </p>
                </div>
                <div>
                  <p className="text-xs text-[#8B7367]">Payment</p>
                  <p className="mt-1 text-[#FAF0E6]">
                    {selectedOrder?.settled_at
                      ? selectedOrder?.payment_method === "GCASH"
                        ? "GCash"
                        : (selectedOrder?.payment_method ?? "Paid")
                      : ["PENDING", "IN_PREP", "READY"].includes(selectedOrder?.status ?? "")
                        ? "Unsettled"
                        : "Not recorded"}
                  </p>
                </div>
                {(selectedOrder?.payment_reference || selectedOrder?.gcash_reference) && (
                  <div className="col-span-2">
                    <p className="text-xs text-[#8B7367]">GCash reference</p>
                    <p className="mt-1 font-mono text-[#E9B988]">
                      {selectedOrder?.payment_reference || selectedOrder?.gcash_reference}
                    </p>
                  </div>
                )}
              </div>

              <div>
                <h3 className="mb-2 text-sm font-semibold text-[#D4A373]">Items</h3>
                {itemsError ? (
                  <p role="alert" className="text-sm text-rose-200">
                    Could not load items for this order.
                  </p>
                ) : itemsLoading ? (
                  <p className="text-sm text-[#C8B6A6]">Loading items…</p>
                ) : activeItems.length ? (
                  <ul className="divide-y divide-[#442E24] rounded-xl border border-[#442E24] bg-[#120B09]/50 px-3">
                    {activeItems.map((item) => {
                      const modifierText = formatModifiers(item.modifiers);
                      return (
                        <li key={item.id} className="flex justify-between gap-3 py-3 text-sm">
                          <span className="text-[#FAF0E6]">
                            <span className="mr-2 font-mono text-[#E9B988]">{item.quantity}×</span>
                            {item.name}
                            {modifierText && (
                              <span className="mt-1 block text-xs text-[#A98D7D]">
                                {modifierText}
                              </span>
                            )}
                          </span>
                          <span className="font-mono text-[#C8B6A6]">
                            {peso(Number(item.item_price) * Number(item.quantity))}
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                ) : (
                  <p className="text-sm text-[#C8B6A6]">
                    {removedItemCount
                      ? "No active items. Removed lines are retained for the ticket audit."
                      : "No item details found."}
                  </p>
                )}
                {activeItems.length > 0 && removedItemCount > 0 && (
                  <p className="mt-2 text-xs text-[#A98D7D]">
                    {removedItemCount} removed {removedItemCount === 1 ? "line is" : "lines are"}{" "}
                    retained for the ticket audit and excluded from the total.
                  </p>
                )}
              </div>

              <div className="flex justify-between border-t border-[#442E24] pt-3 font-mono font-bold">
                <span>Total</span>
                <span className="text-[#E9B988]">
                  {peso(Number(selectedOrder?.total_amount ?? 0))}
                </span>
              </div>
              {selectedOrder.status !== "CANCELLED" && !selectedOrder.settled_at && (
                <div className="grid grid-cols-2 gap-2 border-t border-[#442E24] pt-3">
                  <Button
                    variant="outline"
                    onClick={() => {
                      sessionStorage.setItem("cantilounge:resume-order", selectedOrder.id);
                      setSelectedOrder(null);
                      void navigate({ to: "/pos" });
                    }}
                    className="border-[#D4A373]/40 text-[#E9B988] hover:bg-[#342218]"
                  >
                    Add Items / Resume
                  </Button>
                  <Button
                    onClick={() => setEditingOrder(selectedOrder)}
                    variant="outline"
                    className="border-[#4A3831] text-[#C8B6A6]"
                  >
                    Edit Order
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() => setVoidingOrder(selectedOrder)}
                    className="border-rose-400/40 text-rose-200 hover:bg-rose-950/40"
                  >
                    Void Ticket
                  </Button>
                </div>
              )}
              <div className="border-t border-[#442E24] pt-3">
                <h3 className="mb-2 text-sm font-semibold text-[#D4A373]">Ticket audit</h3>
                {auditLoading ? (
                  <p className="text-xs text-[#C8B6A6]">Loading audit history…</p>
                ) : auditError ? (
                  <p role="alert" className="text-xs text-rose-200">
                    Could not load audit history.
                  </p>
                ) : auditLogs?.length ? (
                  <ul className="space-y-2">
                    {auditLogs.map((entry) => (
                      <li
                        key={entry.id}
                        className="rounded-lg border border-[#442E24] bg-[#120B09]/50 p-2 text-xs"
                      >
                        <div className="flex justify-between gap-2">
                          <span className="font-semibold text-[#E9B988]">{entry.action}</span>
                          <time className="text-[#A98D7D]">
                            {new Intl.DateTimeFormat("en-PH", {
                              timeZone: "Asia/Manila",
                              dateStyle: "medium",
                              timeStyle: "short",
                            }).format(new Date(entry.created_at))}
                          </time>
                        </div>
                        <p className="mt-1 break-all text-[#C8B6A6]">
                          Employee {entry.employee_id}
                          {entry.reason ? ` · ${entry.reason}` : ""}
                        </p>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-xs text-[#A98D7D]">No modifications recorded.</p>
                )}
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
      <TicketEditor
        order={
          editingOrder
            ? {
                id: editingOrder.id,
                order_number: editingOrder.order_number,
                discount_type: editingOrder.discount_type,
              }
            : null
        }
        onClose={() => setEditingOrder(null)}
        onSaved={() => {
          setEditingOrder(null);
          setSelectedOrder(null);
          void qc.invalidateQueries({ queryKey: ["order-history"] });
          void qc.invalidateQueries({ queryKey: ["order-history-items"] });
          void qc.invalidateQueries({ queryKey: ["order-audit"] });
        }}
      />
      <Dialog
        open={!!voidingOrder}
        onOpenChange={(open) => {
          if (!open) {
            setVoidingOrder(null);
            setVoidReason("");
          }
        }}
      >
        <DialogContent className="border-[#3A261D] bg-[#1C120E] text-[#FAF0E6] sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="font-display text-2xl">
              Void ticket #{voidingOrder?.order_number}
            </DialogTitle>
          </DialogHeader>
          <p className="text-sm text-[#C8B6A6]">
            This cancels the ticket and excludes it from collected sales totals.
          </p>
          <label className="space-y-2 text-sm">
            <span>Reason for void</span>
            <select
              value={voidReason}
              onChange={(event) => setVoidReason(event.target.value)}
              className="h-11 w-full rounded-lg border border-[#3A261D] bg-[#120B09] px-3 text-[#FAF0E6]"
            >
              <option value="">Select a reason</option>
              <option>Cashier Mistake</option>
              <option>Customer Cancelled</option>
              <option>Cashier Misclick</option>
              <option>Customer Changed Mind</option>
              <option>Out of Stock</option>
            </select>
          </label>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setVoidingOrder(null)}
              className="border-[#3A261D]"
            >
              Cancel
            </Button>
            <Button
              disabled={!voidReason || savingVoid}
              onClick={voidTicket}
              className="bg-rose-800 text-white hover:bg-rose-700"
            >
              {savingVoid ? "Voiding…" : "Void Ticket"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
