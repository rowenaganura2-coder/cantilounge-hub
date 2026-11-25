import { create } from "zustand";
import { mysql } from "@/integrations/mysql/client";
import { db, type QueuedOrder } from "./offline-db";

type SyncState = {
  online: boolean;
  pending: number;
  syncing: boolean;
  setOnline: (v: boolean) => void;
  refreshPending: () => Promise<void>;
  flush: () => Promise<void>;
};

export const useSync = create<SyncState>((set, get) => ({
  online: true,
  pending: 0,
  syncing: false,
  setOnline: (online) => {
    set({ online });
    if (online) void get().flush();
  },
  refreshPending: async () => set({ pending: await db().queue.count() }),
  flush: async () => {
    if (get().syncing || !navigator.onLine) return;
    set({ syncing: true });
    try {
      const items = await db().queue.orderBy("created_at").toArray();
      for (const q of items) {
        const { data: response, error: placementError } = await mysql.rpc(
          "place_order_with_table",
          {
            payload: q.payload as never,
          },
        );
        let error = placementError?.message ?? null;
        const result = response as { id?: string } | null;
        if (!error && !result?.id) {
          error = "Order sync returned no order ID";
        }
        if (!error && result?.id) {
          const { data: initialOrder, error: verificationError } = await mysql
            .from("orders")
            .select("status, settled_at, payment_method")
            .eq("id", result.id)
            .maybeSingle();
          let savedOrder = initialOrder;
          error = verificationError?.message ?? null;

          const paymentMethod = q.payload["payment_method"];
          if (
            !error &&
            savedOrder &&
            (!savedOrder.settled_at ||
              savedOrder.status !== "COMPLETED" ||
              savedOrder.payment_method !== paymentMethod)
          ) {
            if (paymentMethod !== "CASH" && paymentMethod !== "GCASH") {
              error = "Queued order has no valid payment method";
            } else {
              const { error: settleError } = await mysql.rpc("settle_order", {
                _order_id: result.id,
                _payment_method: paymentMethod,
                _cash_received:
                  paymentMethod === "CASH" ? Number(q.payload["cash_received"] ?? q.total) : 0,
                _gcash_amount: paymentMethod === "GCASH" ? q.total : 0,
                _gcash_reference:
                  paymentMethod === "GCASH" && typeof q.payload["gcash_reference"] === "string"
                    ? q.payload["gcash_reference"] || null
                    : null,
              });
              error = settleError?.message ?? null;
              if (!error) {
                const verification = await mysql
                  .from("orders")
                  .select("status, settled_at, payment_method")
                  .eq("id", result.id)
                  .maybeSingle();
                savedOrder = verification.data;
                error = verification.error?.message ?? null;
              }
            }
          }
          if (
            !error &&
            (!savedOrder?.settled_at ||
              savedOrder.status !== "COMPLETED" ||
              savedOrder.payment_method !== paymentMethod)
          ) {
            error = "Synced order is not marked paid";
          }
        }
        if (!error) {
          await db().queue.delete(q.client_id);
        } else {
          await db().queue.update(q.client_id, {
            attempts: q.attempts + 1,
            last_error: error,
          });
          if (isNetworkError(error)) break;
        }
      }
    } finally {
      set({ syncing: false });
      await get().refreshPending();
    }
  },
}));

function isNetworkError(msg: string) {
  return /fetch|network|failed to/i.test(msg);
}

export async function enqueueOrder(q: Omit<QueuedOrder, "attempts">) {
  await db().queue.put({ ...q, attempts: 0 });
  await useSync.getState().refreshPending();
}

// Called once from the app shell's useEffect.
export function startSyncListeners() {
  const s = useSync.getState();
  s.setOnline(navigator.onLine);
  void s.refreshPending();
  const on = () => useSync.getState().setOnline(true);
  const off = () => useSync.getState().setOnline(false);
  window.addEventListener("online", on);
  window.addEventListener("offline", off);
  const timer = setInterval(() => void useSync.getState().flush(), 30000);
  return () => {
    window.removeEventListener("online", on);
    window.removeEventListener("offline", off);
    clearInterval(timer);
  };
}
