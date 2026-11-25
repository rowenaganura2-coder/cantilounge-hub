import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import {
  Minus,
  Plus,
  Trash2,
  Loader2,
  Coffee,
  BookOpenText,
  Printer,
  Pencil,
  Ban,
  WalletCards,
  ImagePlus,
  Archive,
} from "lucide-react";
import { toast } from "sonner";
import { mysql } from "@/integrations/mysql/client";
import { db, type CachedMenuItem, type CachedCategory } from "@/lib/offline-db";
import { enqueueOrder, useSync } from "@/lib/sync";
import { peso } from "@/lib/staff-auth";
import { sendLowStockAlerts, sendVoidAlert } from "@/lib/notification.functions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { CafeLogo } from "@/components/cafe-logo";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";

export const Route = createFileRoute("/_authenticated/pos")({
  head: () => ({
    meta: [
      { title: "POS — CantiLounge Hub" },
      { name: "description", content: "Take dine-in, takeout and advance orders at Cantilounge." },
      { property: "og:title", content: "POS — CantiLounge Hub" },
      { property: "og:description", content: "Offline-ready point of sale for Cantilounge." },
    ],
  }),
  component: PosPage,
});

type Modifiers = {
  sugar: string;
  ice: string;
  milk: string;
  size?: string;
  syrup?: string;
  notes?: string;
};
type CartLine = {
  key: string;
  item: CachedMenuItem;
  qty: number;
  modifiers: Modifiers | null;
  modPrice: number;
  orderItemId?: string;
};
type ReceiptData = {
  orderNumber: number | null;
  createdAt: string;
  customer: string;
  orderType: "DINE_IN" | "TAKEOUT" | "ADVANCE";
  items: CartLine[];
  subtotal: number;
  discount: number;
  discountType: keyof typeof DISCOUNTS;
  total: number;
  cashReceived: number | null;
  paymentMethod: "CASH" | "GCASH" | null;
  paymentReference: string | null;
};
const OAT_UPCHARGE = 30;
const DISCOUNTS = { NONE: 0, STUDENT: 0.1, SENIOR: 0.2 } as const;
const MERCHANT_GCASH_QR_URL = import.meta.env["VITE_GCASH_QR_IMAGE_URL"]?.trim();

function isMissingRpc(message: string, functionName: string) {
  return (
    message.includes("PGRST202") ||
    (message.toLowerCase().includes("schema cache") &&
      message.toLowerCase().includes(functionName.toLowerCase())) ||
    (message.toLowerCase().includes("could not find the function") &&
      message.toLowerCase().includes(functionName.toLowerCase()))
  );
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object") {
    const details = error as Record<string, unknown>;
    const message = typeof details["message"] === "string" ? details["message"] : null;
    const code = typeof details["code"] === "string" ? details["code"] : null;
    const detail = typeof details["details"] === "string" ? details["details"] : null;
    const hint = typeof details["hint"] === "string" ? details["hint"] : null;
    return [code, message, detail, hint].filter(Boolean).join(" · ") || String(error);
  }
  return String(error);
}

async function fetchMenu() {
  try {
    if (!navigator.onLine) throw new Error("offline");
    const [c, activeMenuResult] = await Promise.all([
      mysql.from("categories").select("id,name,sort_order").order("sort_order"),
      mysql
        .from("menu_items")
        .select(
          "id,name,category_id,base_price,target_station,is_available,is_active,image_url,recipe_ingredients(quantity_req,ingredients(current_stock,is_available))",
        )
        .order("name"),
    ]);
    let m = activeMenuResult;
    if (m.error && /is_active|column.*does not exist|schema cache/i.test(m.error.message)) {
      const legacyMenuResult = await mysql
        .from("menu_items")
        .select(
          "id,name,category_id,base_price,target_station,is_available,image_url,recipe_ingredients(quantity_req,ingredients(current_stock,is_available))",
        )
        .order("name");
      if (legacyMenuResult.error) throw legacyMenuResult.error;
      m = {
        ...legacyMenuResult,
        data: legacyMenuResult.data.map((item) => ({ ...item, is_active: true })),
      };
    }
    if (c.error || m.error) throw c.error ?? m.error;
    const menu = m.data.map(({ recipe_ingredients, ...x }) => {
      // How many servings current stock allows (null = no recipe set).
      let makeable: number | null = null;
      for (const r of recipe_ingredients ?? []) {
        const need = Number(r.quantity_req);
        if (need <= 0) continue;
        const can =
          r.ingredients?.is_available === false
            ? 0
            : Math.floor(Number(r.ingredients?.current_stock ?? 0) / need);
        makeable = makeable === null ? can : Math.min(makeable, can);
      }
      return { ...x, base_price: Number(x.base_price), makeable };
    });
    await db().transaction("rw", db().categories, db().menu, async () => {
      await db().categories.clear();
      await db().menu.clear();
      await db().categories.bulkPut(c.data);
      await db().menu.bulkPut(menu);
    });
    return {
      categories: c.data as CachedCategory[],
      menu: menu as CachedMenuItem[],
      cached: false,
    };
  } catch (error) {
    const [categories, cachedMenu] = await Promise.all([
      db().categories.orderBy("sort_order").toArray(),
      db().menu.toArray(),
    ]);
    const menu = cachedMenu.map((item) => ({ ...item, is_active: item.is_active ?? true }));
    return {
      categories,
      menu,
      cached: true,
      cacheError: error instanceof Error ? error.message : "Menu service is unavailable",
    };
  }
}

function PosPage() {
  const qc = useQueryClient();
  const notifyLowStock = useServerFn(sendLowStockAlerts);
  const { staff } = Route.useRouteContext();
  const online = useSync((s) => s.online);
  const { data, isLoading } = useQuery({ queryKey: ["menu"], queryFn: fetchMenu });
  const [cat, setCat] = useState<string | null>(null);
  const [cart, setCart] = useState<CartLine[]>([]);
  const [orderType, setOrderType] = useState<"DINE_IN" | "TAKEOUT" | "ADVANCE">("DINE_IN");
  const [discount, setDiscount] = useState<keyof typeof DISCOUNTS>("NONE");
  const [customer, setCustomer] = useState("");
  const [tableNumber, setTableNumber] = useState("");
  const [receipt, setReceipt] = useState<ReceiptData | null>(null);
  const [paymentMethod, setPaymentMethod] = useState<"CASH" | "GCASH">("CASH");
  const [cashReceived, setCashReceived] = useState("");
  const [paymentReference, setPaymentReference] = useState("");
  const [checkoutOpen, setCheckoutOpen] = useState(false);
  const [resumedOrderId, setResumedOrderId] = useState<string | null>(null);
  const [resumedOrderNumber, setResumedOrderNumber] = useState<number | null>(null);
  const [modFor, setModFor] = useState<CachedMenuItem | null>(null);
  const [modLineFor, setModLineFor] = useState<CartLine | null>(null);
  const [placing, setPlacing] = useState(false);
  const checkoutClientId = useRef<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [photoEditorOpen, setPhotoEditorOpen] = useState(false);
  const [menuManagerOpen, setMenuManagerOpen] = useState(false);

  useEffect(() => {
    if (!data) return;
    const orderId = sessionStorage.getItem("cantilounge:resume-order");
    if (!orderId) return;

    let cancelled = false;

    const resumeTicket = async () => {
      try {
        const { data: order, error: orderError } = await mysql
          .from("orders")
          .select(
            "id, order_number, order_type, customer_name, table_number, discount_type, status, settled_at",
          )
          .eq("id", orderId)
          .maybeSingle();
        if (orderError) throw orderError;
        if (!order || order.settled_at || order.status === "CANCELLED") {
          throw new Error("This ticket is no longer open.");
        }
        const { data: savedItems, error: itemsError } = await mysql
          .from("order_items")
          .select("id, menu_item_id, quantity, item_price, modifiers, item_status")
          .eq("order_id", orderId);
        if (itemsError) throw itemsError;
        const menuList = data?.menu ?? [];

        const restoredCart = (savedItems ?? []).flatMap((savedItem) => {
          const menuItem = menuList.find((item) => item.id === savedItem.menu_item_id) ?? {
            id: savedItem.menu_item_id,
            name: "Restored Item",
            base_price: Number(savedItem.item_price),
            category_id: "",
            target_station: "BARISTA" as const,
            is_available: false,
            is_active: false,
            image_url: null,
            makeable: null,
          };

          const modifiers = savedItem.modifiers as Modifiers | null;
          const modPrice = modifiers?.milk === "oat" ? OAT_UPCHARGE : 0;

          return [
            {
              key: `${menuItem.id}|${JSON.stringify(modifiers)}|${savedItem.id}`,
              item: { ...menuItem, base_price: Number(savedItem.item_price) - modPrice },
              qty: savedItem.item_status === "CANCELLED" ? 0 : savedItem.quantity,
              modifiers,
              modPrice,
              orderItemId: savedItem.id,
            },
          ];
        });

        setCart(restoredCart);
        setResumedOrderId(order.id);
        setResumedOrderNumber(order.order_number);
        setOrderType(order.order_type);
        setCustomer(order.customer_name ?? "");
        setTableNumber(order.table_number ?? "");
        setDiscount(
          order.discount_type === "STUDENT" || order.discount_type === "SENIOR"
            ? order.discount_type
            : "NONE",
        );
        sessionStorage.removeItem("cantilounge:resume-order");
        toast.success(`Ticket #${order.order_number} resumed`);
      } catch (error) {
        if (!cancelled) {
          toast.error(`Could not resume this ticket: ${errorMessage(error)}`);
        }
      }
    };

    void resumeTicket();
    return () => {
      cancelled = true;
    };
  }, [data]);
  // Servings already in the cart reduce what's left to make.
  const inCart = (id: string) =>
    cart.filter((l) => l.item.id === id).reduce((s, l) => s + l.qty, 0);
  const canMake = (m: CachedMenuItem) =>
    m.is_available && (m.makeable === null || m.makeable - inCart(m.id) > 0);
  const activeCat = cat ?? data?.categories[0]?.id ?? null;
  const items =
    data?.menu.filter(
      (m) => m.is_active && m.category_id === activeCat && (showAll || canMake(m)),
    ) ?? [];
  const availableCount = data?.menu.filter(canMake).length ?? 0;
  const subtotal = cart.reduce((s, l) => s + (l.item.base_price + l.modPrice) * l.qty, 0);
  const disc = Math.round(subtotal * DISCOUNTS[discount] * 100) / 100;
  const total = subtotal - disc;
  const cashAmount = Number(cashReceived || total);

  const addLine = (item: CachedMenuItem, modifiers: Modifiers | null) => {
    const modPrice = modifiers?.milk === "oat" ? OAT_UPCHARGE : 0;
    const key = `${item.id}|${JSON.stringify(modifiers)}`;
    setCart((c) => {
      const ex = c.find((l) => l.key === key);
      if (ex) return c.map((l) => (l.key === key ? { ...l, qty: l.qty + 1 } : l));
      return [...c, { key, item, qty: 1, modifiers, modPrice }];
    });
  };

  const placeOrder = async (hold = false) => {
    if (!cart.some((line) => line.qty > 0)) return;
    if (hold && !navigator.onLine) {
      toast.error("Connect to the internet to save a held ticket.");
      return;
    }
    if (!hold && paymentMethod === "GCASH") {
      if (!MERCHANT_GCASH_QR_URL) {
        toast.error("Set VITE_GCASH_QR_IMAGE_URL to the cafe's official merchant QR first");
        return;
      }
      if (paymentReference.trim() && !/^\d{4,13}$/.test(paymentReference.trim())) {
        toast.error("GCash reference must be 4–13 digits when provided");
        return;
      }
    }
    if (!hold && paymentMethod === "CASH" && (!Number.isFinite(cashAmount) || cashAmount < total)) {
      toast.error("Cash received must cover the order total");
      return;
    }
    setPlacing(true);
    const client_id = checkoutClientId.current ?? crypto.randomUUID();
    const created_at = new Date().toISOString();
    const payload = {
      client_id,
      order_type: orderType,
      customer_name: customer,
      table_number: tableNumber,
      discount_type: discount === "NONE" ? "" : discount,
      payment_method: hold ? "UNPAID" : paymentMethod,
      cash_received: !hold && paymentMethod === "CASH" ? Math.round(cashAmount * 100) / 100 : 0,
      gcash_amount: !hold && paymentMethod === "GCASH" ? total : 0,
      gcash_reference: !hold && paymentMethod === "GCASH" ? paymentReference.trim() || null : null,
      created_at,
      items: cart
        .filter((line) => line.qty > 0)
        .map((l) => ({
          menu_item_id: l.item.id,
          quantity: l.qty,
          modifiers: l.modifiers,
          modifier_price: l.modPrice,
        })),
    };
    const reset = () => {
      setCart([]);
      setCustomer("");
      setTableNumber("");
      setDiscount("NONE");
      setResumedOrderId(null);
      setResumedOrderNumber(null);
    };
    try {
      if (!navigator.onLine) throw new TypeError("offline");
      let r: { id: string; order_number: number };
      let savedTable = true;
      if (resumedOrderId) {
        const { error } = await mysql.rpc("update_open_order", {
          _order_id: resumedOrderId,
          _items: cart.map((line) => ({
            id: line.orderItemId ?? null,
            menu_item_id: line.item.id,
            quantity: line.qty,
            modifiers: line.modifiers,
          })),
          _discount_type: discount === "NONE" ? "" : discount,
          _customer_name: customer.trim() || null,
          _order_type: orderType,
          _table_number: tableNumber.trim() || null,
        });
        if (error) throw new Error(error.message);
        r = { id: resumedOrderId, order_number: resumedOrderNumber ?? 0 };
      } else {
        checkoutClientId.current ??= client_id;
        let { data: res, error } = await mysql.rpc("place_order_with_table", { payload });
        if (error) {
          if (/fetch|network/i.test(error.message)) throw new TypeError(error.message);
          if (isMissingRpc(error.message, "place_order_with_table")) {
            if (hold) {
              throw new Error(
                "The POS database migrations are not fully applied. Apply migrations through 20261020160000_ticket_checkout_and_rpc_fixes.sql, then retry.",
              );
            }
            const fallback = await mysql.rpc("place_order", { payload });
            res = fallback.data;
            error = fallback.error;
            savedTable = false;
          }
        }
        if (error) {
          if (/fetch|network/i.test(error.message)) throw new TypeError(error.message);
          toast.error(error.message);
          return;
        }
        const result = res as { id?: string; order_number?: number };
        if (!result.id || !result.order_number) {
          toast.error("The order was created, but its status could not be verified.");
          return;
        }
        r = { id: result.id, order_number: result.order_number };
      }
      if (hold) {
        const { data: heldOrder, error: verificationError } = await mysql
          .from("orders")
          .select("payment_method, settled_at")
          .eq("id", r.id)
          .maybeSingle();
        if (verificationError) throw verificationError;
        if (!heldOrder || heldOrder.settled_at || heldOrder.payment_method !== "UNPAID") {
          toast.error(`Ticket #${r.order_number} was saved, but could not be verified as unpaid.`);
          return;
        }
        void notifyLowStock()
          .then(({ sent }) => {
            if (sent > 0) toast.info(`Inventory alert emailed for ${sent} item(s).`);
          })
          .catch((error: unknown) =>
            toast.error(`Ticket saved, but inventory email alert failed: ${errorMessage(error)}`),
          );
        toast.success(`Ticket #${r.order_number} saved as an open ticket`);
        if (!savedTable && tableNumber.trim()) {
          toast.warning(
            "Ticket saved, but its table number was not stored. Apply the latest POS migration.",
          );
        }
        reset();
        checkoutClientId.current = null;
        setPaymentReference("");
        setCheckoutOpen(false);
        void qc.invalidateQueries({ queryKey: ["menu"] });
        void qc.invalidateQueries({ queryKey: ["order-history"] });
        return;
      }
      let { data: savedOrder, error: verificationError } = await mysql
        .from("orders")
        .select("status, settled_at, payment_method")
        .eq("id", r.id)
        .maybeSingle();
      if (verificationError) {
        toast.error(
          `Order #${r.order_number} was created, but payment status could not be verified.`,
        );
        return;
      }
      if (
        savedOrder &&
        (!savedOrder.settled_at ||
          savedOrder.status !== "COMPLETED" ||
          savedOrder.payment_method !== paymentMethod)
      ) {
        const { error: settleError } = await mysql.rpc("settle_order", {
          _order_id: r.id,
          _payment_method: paymentMethod,
          _cash_received: paymentMethod === "CASH" ? Math.round(cashAmount * 100) / 100 : 0,
          _gcash_amount: paymentMethod === "GCASH" ? total : 0,
          _gcash_reference: paymentMethod === "GCASH" ? paymentReference.trim() || null : null,
        });
        if (settleError) {
          void qc.invalidateQueries({ queryKey: ["order-history"] });
          toast.error(
            isMissingRpc(settleError.message, "settle_order")
              ? `Order #${r.order_number} was created but remains unpaid. Apply the latest Supabase checkout migration.`
              : `Order #${r.order_number} was created but payment was not recorded: ${settleError.message}`,
          );
          return;
        }
        const verification = await mysql
          .from("orders")
          .select("status, settled_at, payment_method")
          .eq("id", r.id)
          .maybeSingle();
        savedOrder = verification.data;
        verificationError = verification.error;
      }
      if (verificationError) {
        toast.error(
          `Order #${r.order_number} was created, but payment status could not be verified.`,
        );
        return;
      }
      if (
        !savedOrder?.settled_at ||
        savedOrder.status !== "COMPLETED" ||
        savedOrder.payment_method !== paymentMethod
      ) {
        toast.error(
          `Order #${r.order_number} was created but is still unpaid. Apply the latest Supabase checkout migration.`,
        );
        return;
      }
      const received = Math.round(cashAmount * 100) / 100;
      void notifyLowStock()
        .then(({ sent }) => {
          if (sent > 0) toast.info(`Inventory alert emailed for ${sent} item(s).`);
        })
        .catch((error: unknown) =>
          toast.error(`Order paid, but inventory email alert failed: ${errorMessage(error)}`),
        );
      const cashForReceipt = paymentMethod === "CASH" ? received : null;
      const savedPaymentMethod = paymentMethod;
      toast.success(
        paymentMethod === "GCASH"
          ? `Order #${r.order_number} completed and GCash payment recorded`
          : `Order #${r.order_number} completed and cash payment recorded`,
      );
      if (!savedTable && tableNumber.trim()) {
        toast.warning(
          "Order paid successfully, but table number was not saved. Apply the latest POS migration.",
        );
      }
      setReceipt({
        orderNumber: r.order_number,
        createdAt: created_at,
        customer,
        orderType,
        items: cart,
        subtotal,
        discount: disc,
        discountType: discount,
        total,
        cashReceived: cashForReceipt,
        paymentMethod: savedPaymentMethod,
        paymentReference: savedPaymentMethod === "GCASH" ? paymentReference : null,
      });
      reset();
      checkoutClientId.current = null;
      setPaymentReference("");
      setCheckoutOpen(false);
      qc.invalidateQueries({ queryKey: ["menu"] });
      qc.invalidateQueries({ queryKey: ["order-history"] });
    } catch (error) {
      if (hold || resumedOrderId) {
        toast.error(
          `${hold ? "Could not save this held ticket" : "Could not update this ticket"}: ${errorMessage(error)}`,
        );
        return;
      }
      const offlinePayload = {
        ...payload,
        payment_method: paymentMethod,
        cash_received: paymentMethod === "CASH" ? Math.round(cashAmount * 100) / 100 : 0,
        gcash_amount: paymentMethod === "GCASH" ? total : 0,
        gcash_reference: paymentMethod === "GCASH" ? paymentReference.trim() || null : null,
        offline: true,
      };
      const failureMessage = errorMessage(error);
      if (navigator.onLine && !/fetch|network|failed to/i.test(failureMessage)) {
        toast.error(`Could not complete checkout: ${failureMessage}`);
        return;
      }
      await enqueueOrder({ client_id, payload: offlinePayload, total, created_at });
      toast.warning(
        "Offline — order and payment saved on this device and will sync automatically.",
      );
      setReceipt({
        orderNumber: null,
        createdAt: created_at,
        customer,
        orderType,
        items: cart,
        subtotal,
        discount: disc,
        discountType: discount,
        total,
        cashReceived: null,
        paymentMethod: null,
        paymentReference: null,
      });
      reset();
      checkoutClientId.current = null;
      setPaymentReference("");
      setCheckoutOpen(false);
    } finally {
      setPlacing(false);
    }
  };

  return (
    <div className="relative h-[calc(100dvh-3rem)] min-h-0 overflow-hidden bg-[url('/cafee.avif')] bg-cover bg-center bg-no-repeat text-[#FAF0E6] sm:h-dvh">
      <div className="absolute inset-0 bg-[#160E0B]/85 backdrop-blur-[2px]" />
      <div className="relative z-10 mx-auto grid h-full min-h-0 max-w-[1600px] grid-cols-1 gap-6 overflow-y-auto p-4 sm:p-5 lg:grid-cols-[minmax(0,1fr)_380px] lg:overflow-hidden lg:p-6">
        <section className="flex min-h-0 flex-col rounded-[32px] border border-[#4A3831] bg-[#1E1512]/80 p-4 shadow-[0_30px_80px_rgba(0,0,0,0.28)] backdrop-blur-md sm:p-5 lg:p-6">
          <header className="mb-5 flex flex-col items-stretch gap-3 border-b border-[#4A3831]/70 pb-4 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
            <div className="flex min-w-0 items-center gap-3">
              <div className="flex h-12 w-14 items-center justify-center overflow-hidden rounded-2xl border border-[#5A3E31] bg-[#F5EBE0]/8 p-1">
                <CafeLogo className="h-10 w-auto object-contain" />
              </div>
              <div className="min-w-0">
                <h1 className="font-display text-2xl leading-tight text-[#FAF0E6] sm:text-4xl">
                  Point of Sale
                </h1>
                <p className="mt-1 text-xs leading-snug text-[#C8B6A6] sm:text-sm">
                  {availableCount} of {data?.menu.length ?? 0} items can be made with current stock
                </p>
              </div>
            </div>
            <div className="flex w-full min-w-0 flex-wrap items-center gap-2 sm:w-auto sm:justify-end">
              {data?.cached && (
                <span className="rounded-full border border-[#D4A373]/30 bg-[#D4A373]/10 px-2.5 py-1 text-[10px] uppercase tracking-[0.2em] text-[#E9B988]">
                  Using saved menu
                </span>
              )}
              <div className="grid grid-cols-2 gap-1 rounded-xl border border-[#4A3831] bg-[#2A1F1B] p-1 text-xs font-semibold shadow-inner">
                <button
                  onClick={() => setShowAll(false)}
                  className={`rounded-lg px-3 py-1.5 transition ${!showAll ? "bg-[#D4A373] text-[#1A120F]" : "text-[#C8B6A6] hover:text-[#FAF0E6]"}`}
                >
                  Available
                </button>
                <button
                  onClick={() => setShowAll(true)}
                  className={`rounded-lg px-3 py-1.5 transition ${showAll ? "bg-[#D4A373] text-[#1A120F]" : "text-[#C8B6A6] hover:text-[#FAF0E6]"}`}
                >
                  All
                </button>
              </div>
              {data?.cached && (
                <span
                  title={data.cacheError}
                  className="max-w-40 truncate text-[10px] text-amber-200"
                >
                  Saved menu · live load failed
                </span>
              )}
              <Button
                variant="outline"
                onClick={() => {
                  if (!staff.roles.some((role) => role === "ADMIN" || role === "MANAGER")) {
                    toast.error("Only managers and admins can manage menu items.");
                    return;
                  }
                  setMenuManagerOpen(true);
                }}
                className="h-10 border-[#D4A373]/40 bg-[#251A15] px-3 text-xs text-[#E9B988] hover:bg-[#D4A373]/10"
              >
                <Plus className="mr-1.5 size-4" />
                Manage menu
              </Button>
              <Button
                variant="outline"
                onClick={() => {
                  if (!staff.roles.some((role) => role === "ADMIN" || role === "MANAGER")) {
                    toast.error("Only managers and admins can edit menu photos.");
                    return;
                  }
                  setPhotoEditorOpen(true);
                }}
                className="h-10 border-[#D4A373]/40 bg-[#251A15] px-3 text-xs text-[#E9B988] hover:bg-[#D4A373]/10"
              >
                <ImagePlus className="mr-1.5 size-4" />
                Edit photos
              </Button>
            </div>
          </header>

          <div className="mb-5 overflow-hidden rounded-[26px] border border-[#D4A373]/25 bg-[linear-gradient(135deg,#f5ede0_0%,#e9dcc3_55%,#f3e7d7_100%)] p-4 text-[#271b18] shadow-[0_18px_40px_rgba(0,0,0,0.12)]">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex items-center gap-3">
                <div className="grid size-11 place-items-center rounded-2xl bg-[#1A120F]/10 ring-1 ring-[#1A120F]/20">
                  <Coffee className="size-5" />
                </div>
                <div>
                  <p className="text-[10px] uppercase tracking-[0.28em] text-[#5A3E31]">
                    Cantilounge
                  </p>
                  <p className="font-display text-2xl leading-none text-[#1f1714]">
                    Where books meet brews.
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-2 rounded-full border border-[#1A120F]/15 bg-[#1A120F]/5 px-3 py-1.5 text-[10px] font-semibold uppercase tracking-[0.15em] text-[#5A3E31]">
                <BookOpenText className="size-3.5" />
                Slow pours. Busy hearts.
              </div>
            </div>
          </div>

          <div className="scrollbar-none -mx-4 mb-5 flex gap-2 overflow-x-auto px-4 pb-1 sm:mx-0 sm:px-0">
            {data?.categories.map((c) => {
              const n = data.menu.filter((m) => m.category_id === c.id && canMake(m)).length;
              return (
                <button
                  key={c.id}
                  onClick={() => setCat(c.id)}
                  className={`whitespace-nowrap rounded-full border px-4 py-2 text-sm font-medium transition ${activeCat === c.id ? "border-[#D4A373] bg-[#D4A373] text-[#1A120F] shadow-sm" : "border-[#4A3831] bg-[#2A1F1B] text-[#C8B6A6] hover:border-[#D4A373] hover:text-[#FAF0E6]"}`}
                >
                  {c.name} <span className="ml-1 font-mono text-[10px] opacity-80">{n}</span>
                </button>
              );
            })}
          </div>

          {isLoading ? (
            <div className="flex min-h-[320px] items-center justify-center">
              <Loader2 className="animate-spin text-[#D4A373]" />
            </div>
          ) : (
            <div className="scrollbar-espresso grid min-h-0 flex-1 auto-rows-max grid-cols-2 gap-4 overflow-y-auto overscroll-contain pb-6 pr-1 scroll-smooth md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
              {items.length === 0 && (
                <p className="col-span-full mt-10 text-center text-sm text-[#C8B6A6]">
                  Nothing in this category can be made right now.
                </p>
              )}
              {items.map((m) => {
                const ok = canMake(m);
                const low = ok && m.makeable !== null && m.makeable - inCart(m.id) <= 5;
                return (
                  <button
                    key={m.id}
                    disabled={!ok}
                    onClick={() =>
                      m.target_station === "BARISTA" ? setModFor(m) : addLine(m, null)
                    }
                    className={`group h-auto overflow-hidden rounded-2xl border text-left transition-all duration-200 hover:-translate-y-0.5 hover:border-[#D4A373] active:scale-[0.99] ${ok ? "border-[#3E2C24] bg-[#251A15]" : "border-[#3E2C24] bg-[#211914] opacity-60 grayscale"} ${low && ok ? "shadow-[0_0_0_1px_rgba(212,163,115,0.2)]" : ""}`}
                  >
                    <div className="relative aspect-[3/2] overflow-hidden bg-[#38271E]">
                      {m.image_url ? (
                        <img
                          src={m.image_url}
                          alt={m.name}
                          loading="lazy"
                          decoding="async"
                          onError={(event) => {
                            if (!event.currentTarget.src.endsWith("/cafee.avif")) {
                              event.currentTarget.src = "/cafee.avif";
                            }
                          }}
                          className="size-full object-cover transition-transform duration-300 group-hover:scale-105"
                        />
                      ) : (
                        <div className="grid size-full place-items-center bg-[radial-gradient(circle_at_center,#4A3022,#211712)] text-[#E9B988]">
                          <div className="grid size-20 place-items-center rounded-full border border-[#D4A373]/35 bg-[#1A120F]/55 shadow-[0_10px_30px_rgba(0,0,0,0.25)] sm:size-24">
                            <span
                              className="font-display text-3xl font-semibold tracking-wide"
                              aria-hidden="true"
                            >
                              {m.name
                                .split(/\s+/)
                                .slice(0, 2)
                                .map((part) => part[0])
                                .join("")
                                .toUpperCase()}
                            </span>
                          </div>
                          <Coffee
                            className="absolute bottom-3 right-3 size-5 opacity-70"
                            aria-hidden="true"
                          />
                        </div>
                      )}
                      <div className="absolute inset-x-3 top-3 flex w-[calc(100%-1.5rem)] items-center justify-between gap-1">
                        <span className="min-w-0 max-w-[65%] truncate rounded-full border border-[#E9B988]/30 bg-[#1A120F]/85 px-2.5 py-1 text-[9px] font-semibold uppercase tracking-[0.08em] text-[#FAF0E6] sm:text-[10px] sm:tracking-[0.12em]">
                          {data?.categories.find((c) => c.id === m.category_id)?.name ?? "Menu"}
                        </span>
                        {m.makeable !== null && (
                          <span
                            className={`shrink-0 rounded-full border px-2 py-1 font-mono text-[9px] leading-none sm:px-2.5 sm:text-[10px] ${!ok ? "border-[#E46A6A]/40 bg-[#431F1F]/90 text-[#F0A7A7]" : low ? "border-[#D4A373]/50 bg-[#342218]/90 text-[#E9B988]" : "border-emerald-800/50 bg-emerald-950/85 text-emerald-300"}`}
                          >
                            {!ok ? "86'd" : low ? `${m.makeable - inCart(m.id)} left` : "In stock"}
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="flex min-h-[112px] flex-col justify-between gap-3 p-4">
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0 flex-1">
                          <div className="font-semibold leading-tight text-[#FAF0E6]">{m.name}</div>
                        </div>
                      </div>
                      <div className="flex min-w-0 items-end justify-between gap-1.5">
                        <span className="min-w-0 truncate text-[9px] uppercase tracking-[0.1em] text-[#A98D7D] sm:text-[10px] sm:tracking-[0.14em]">
                          {m.target_station}
                        </span>
                        <div className="shrink-0 whitespace-nowrap font-mono text-base font-bold tabular text-[#E9B988] sm:text-lg">
                          {peso(m.base_price)}
                        </div>
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </section>

        <aside className="flex min-h-0 flex-col rounded-[32px] border border-[#4A3831] bg-[#1A110D]/90 p-4 shadow-[0_26px_60px_rgba(0,0,0,0.2)] backdrop-blur-lg sm:p-5">
          <div className="border-b border-[#4A3831]/70 pb-4">
            <div className="grid grid-cols-3 gap-1 rounded-2xl border border-[#4A3831] bg-[#251A15] p-1">
              {(["DINE_IN", "TAKEOUT", "ADVANCE"] as const).map((t) => (
                <button
                  key={t}
                  onClick={() => setOrderType(t)}
                  className={`rounded-xl py-2 text-[10px] font-semibold uppercase tracking-[0.18em] transition ${orderType === t ? "bg-[#D4A373] text-[#1A120F] shadow-sm" : "bg-[#251A15] text-[#C8B6A6] hover:text-[#FAF0E6]"}`}
                >
                  {t.replace("_", " ")}
                </button>
              ))}
            </div>
            <div className="mt-3 grid grid-cols-[minmax(0,1fr)_100px] gap-2">
              <Input
                className="h-11 rounded-xl border-[#4A3831] bg-[#1E1512] text-[#FAF0E6] placeholder:text-[#8B7367] focus:border-[#D4A373]"
                placeholder="Customer name"
                maxLength={120}
                value={customer}
                onChange={(e) => setCustomer(e.target.value)}
              />
              <Input
                className="h-11 rounded-xl border-[#4A3831] bg-[#1E1512] text-[#FAF0E6] placeholder:text-[#8B7367] focus:border-[#D4A373]"
                placeholder="Table #"
                maxLength={40}
                value={tableNumber}
                onChange={(e) => setTableNumber(e.target.value)}
              />
            </div>
          </div>

          <div className="min-h-0 flex-1 space-y-3 overflow-y-auto overscroll-contain py-4">
            {cart.length === 0 && (
              <div className="mt-6 flex min-h-[220px] flex-col items-center justify-center rounded-[24px] border border-dashed border-[#5A3E31] bg-[#261d1a]/70 p-6 text-center">
                <div className="mb-4 grid size-14 place-items-center rounded-full bg-[#D4A373]/10 text-[#E9B988] ring-1 ring-[#D4A373]/25">
                  <Coffee className="size-7" />
                </div>
                <p className="max-w-xs text-sm leading-relaxed text-[#C8B6A6]">
                  No items in ticket yet. Select a drink or pastry from the menu to start an order.
                </p>
              </div>
            )}
            {cart.map((l) => (
              <div key={l.key} className="rounded-2xl border border-[#3E2C24] bg-[#261d1a] p-3">
                <div className="flex justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="font-medium text-[#FAF0E6]">{l.item.name}</div>
                    {l.qty === 0 && (
                      <span className="mt-1 block text-[10px] uppercase tracking-[0.12em] text-[#A98D7D]">
                        Removed from ticket
                      </span>
                    )}
                    {l.modifiers && (
                      <div className="mt-1 text-[11px] text-[#C8B6A6]">
                        {l.modifiers.size && `${l.modifiers.size} · `}
                        Sugar {l.modifiers.sugar} · Ice {l.modifiers.ice} · {l.modifiers.milk} milk
                        {l.modifiers.syrup && l.modifiers.syrup !== "none"
                          ? ` · ${l.modifiers.syrup} syrup`
                          : ""}
                        {l.modifiers.notes && (
                          <span className="block">Note: {l.modifiers.notes}</span>
                        )}
                      </div>
                    )}
                  </div>
                  <div className="font-mono text-sm font-semibold text-[#E9B988] tabular">
                    {peso((l.item.base_price + l.modPrice) * l.qty)}
                  </div>
                </div>
                <div className="mt-3 flex items-center gap-2">
                  <Button
                    size="icon"
                    variant="outline"
                    className="size-7 rounded-full border-[#4A3831] bg-[#1E1512] text-[#F5EBE0]"
                    onClick={() =>
                      setCart((c) =>
                        c.map((x) =>
                          x.key === l.key
                            ? { ...x, qty: Math.max(x.orderItemId ? 0 : 1, x.qty - 1) }
                            : x,
                        ),
                      )
                    }
                  >
                    <Minus />
                  </Button>
                  <span className="w-6 text-center font-mono text-[#FAF0E6]">{l.qty}</span>
                  <Button
                    size="icon"
                    variant="outline"
                    className="size-7 rounded-full border-[#4A3831] bg-[#1E1512] text-[#F5EBE0]"
                    onClick={() =>
                      setCart((c) => c.map((x) => (x.key === l.key ? { ...x, qty: x.qty + 1 } : x)))
                    }
                  >
                    <Plus />
                  </Button>
                  {l.qty > 0 && l.item.target_station === "BARISTA" && (
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 rounded-full border-[#4A3831] px-2 text-[10px] text-[#E9B988]"
                      onClick={() => setModLineFor(l)}
                    >
                      <Pencil className="mr-1 size-3" />
                      Customize
                    </Button>
                  )}
                  <Button
                    size="icon"
                    variant="ghost"
                    className="ml-auto size-7 rounded-full text-[#F5B8B2] hover:bg-[#5C2F2D]"
                    onClick={() =>
                      setCart((current) =>
                        l.orderItemId
                          ? current.map((line) => (line.key === l.key ? { ...line, qty: 0 } : line))
                          : current.filter((line) => line.key !== l.key),
                      )
                    }
                  >
                    <Trash2 />
                  </Button>
                </div>
              </div>
            ))}
          </div>

          <div className="space-y-4 border-t border-[#4A3831]/70 pt-4">
            <div className="grid grid-cols-3 gap-2">
              {(Object.keys(DISCOUNTS) as (keyof typeof DISCOUNTS)[]).map((d) => (
                <button
                  key={d}
                  onClick={() => setDiscount(d)}
                  className={`rounded-xl border px-2 py-2 text-[10px] font-semibold uppercase tracking-[0.12em] transition ${discount === d ? "border-[#D4A373] bg-[#D4A373] text-[#1A120F]" : "border-[#4A3831] bg-[#251A15] text-[#C8B6A6] hover:border-[#D4A373]/80 hover:text-[#FAF0E6]"}`}
                >
                  {d === "NONE" ? "No discount" : `${d} ${DISCOUNTS[d] * 100}%`}
                </button>
              ))}
            </div>

            <div className="space-y-2 font-mono text-sm text-[#C8B6A6] tabular">
              <Row label="Subtotal" value={peso(subtotal)} />
              {disc > 0 && <Row label="Discount" value={`−${peso(disc)}`} />}
              <div className="flex justify-between border-t border-[#4A3831]/70 pt-2 text-xl font-bold text-[#FAF0E6]">
                <span>Total</span>
                <span>{peso(total)}</span>
              </div>
            </div>

            {resumedOrderId && (
              <p className="text-center text-xs font-semibold uppercase tracking-[0.14em] text-[#E9B988]">
                Resuming open ticket #{resumedOrderNumber}
              </p>
            )}
            <div className="grid grid-cols-2 gap-2">
              <Button
                variant="outline"
                className="h-12 rounded-xl border-[#D4A373]/50 bg-[#251A15] text-sm font-bold text-[#E9B988] hover:bg-[#342218]"
                disabled={!cart.some((line) => line.qty > 0) || placing}
                onClick={() => void placeOrder(true)}
              >
                {resumedOrderId ? "Save Ticket" : "Hold Ticket"}
              </Button>
              <Button
                className="h-12 rounded-xl bg-[linear-gradient(135deg,#d7ad78_0%,#c68d5d_100%)] text-sm font-bold text-[#1A120F] shadow-[0_18px_28px_rgba(198,141,93,0.3)] hover:bg-[linear-gradient(135deg,#dcb07d_0%,#c78c56_100%)]"
                disabled={!cart.some((line) => line.qty > 0) || placing}
                onClick={() => setCheckoutOpen(true)}
              >
                {resumedOrderId ? "Checkout Ticket" : "Pay Now"}
              </Button>
            </div>
          </div>
        </aside>
      </div>

      <Dialog
        open={checkoutOpen}
        onOpenChange={(open) => {
          if (!placing) setCheckoutOpen(open);
        }}
      >
        <DialogContent className="max-h-[90vh] max-w-md overflow-y-auto border-[#332017] bg-[#1C120E] text-[#EAE2D8]">
          <DialogHeader>
            <DialogTitle className="font-display text-2xl text-[#FAF0E6]">
              Complete payment
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="flex items-center justify-between rounded-xl border border-[#332017] bg-[#251A15] p-3">
              <span className="text-sm text-[#C8B6A6]">{cart.length} item type(s)</span>
              <span className="font-mono text-xl font-bold text-[#E9B988]">{peso(total)}</span>
            </div>
            <div className="grid grid-cols-2 gap-2">
              {(["CASH", "GCASH"] as const).map((method) => (
                <button
                  key={method}
                  type="button"
                  onClick={() => {
                    setPaymentMethod(method);
                    if (method === "CASH") setCashReceived(total.toFixed(2));
                  }}
                  className={`min-h-11 rounded-lg border text-sm font-semibold ${paymentMethod === method ? "border-[#B85D19] bg-[#B85D19] text-white" : "border-[#332017] bg-[#251A15] text-[#C8B6A6] hover:text-[#FAF0E6]"}`}
                >
                  {method === "CASH" ? "Cash" : "GCash"}
                </button>
              ))}
            </div>
            {paymentMethod === "CASH" ? (
              <label className="block space-y-1 text-sm text-[#C8B6A6]">
                Cash received
                <Input
                  type="number"
                  min={total}
                  step="0.01"
                  value={cashReceived || total.toFixed(2)}
                  onChange={(event) => setCashReceived(event.target.value)}
                  className="mt-1 border-[#332017] bg-[#120B09] font-mono text-[#FAF0E6]"
                />
                <span className="block text-xs text-[#A98D7D]">
                  Change: {peso(Math.max(0, cashAmount - total))}
                </span>
              </label>
            ) : (
              <div className="space-y-3">
                <MerchantQrCode />
                <label className="block space-y-1 text-sm text-[#C8B6A6]">
                  GCash transaction reference (optional)
                  <Input
                    inputMode="numeric"
                    maxLength={13}
                    placeholder="Optional · 4–13 digits"
                    value={paymentReference}
                    onChange={(event) =>
                      setPaymentReference(event.target.value.replace(/\D/g, "").slice(0, 13))
                    }
                    className="mt-1 border-[#332017] bg-[#120B09] font-mono text-[#FAF0E6]"
                  />
                </label>
              </div>
            )}
          </div>
          <DialogFooter className="gap-2 sm:gap-2">
            <Button
              variant="outline"
              disabled={placing}
              onClick={() => setCheckoutOpen(false)}
              className="border-[#332017] bg-transparent text-[#C8B6A6] hover:bg-[#251A15] hover:text-[#FAF0E6]"
            >
              Cancel
            </Button>
            <Button
              disabled={
                placing ||
                (paymentMethod === "GCASH"
                  ? !MERCHANT_GCASH_QR_URL ||
                    (Boolean(paymentReference) && !/^\d{4,13}$/.test(paymentReference))
                  : !Number.isFinite(cashAmount) || cashAmount < total)
              }
              onClick={() => void placeOrder(false)}
              className="bg-[#B85D19] font-semibold text-white hover:bg-[#A34F15]"
            >
              {placing && <Loader2 className="mr-2 size-4 animate-spin" />}
              {online ? "Complete payment" : "Save checkout offline"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ModifierDialog
        item={modLineFor?.item ?? modFor}
        initialModifiers={modLineFor?.modifiers ?? null}
        onClose={() => {
          setModFor(null);
          setModLineFor(null);
        }}
        onAdd={(m) => {
          if (modLineFor) {
            setCart((current) =>
              current.map((line) => {
                if (line.key !== modLineFor.key) return line;
                return {
                  ...line,
                  key: `${line.item.id}|${JSON.stringify(m)}${line.orderItemId ? `|${line.orderItemId}` : ""}`,
                  modifiers: m,
                  modPrice: m.milk === "oat" ? OAT_UPCHARGE : 0,
                };
              }),
            );
          } else if (modFor) {
            addLine(modFor, m);
          }
          setModFor(null);
          setModLineFor(null);
        }}
      />
      <MenuItemManager
        open={menuManagerOpen}
        items={data?.menu ?? []}
        categories={data?.categories ?? []}
        offline={!online}
        loadIssue={data?.cacheError}
        onClose={() => setMenuManagerOpen(false)}
        onChanged={() => {
          void qc.invalidateQueries({ queryKey: ["menu"] });
          void qc.invalidateQueries({ queryKey: ["ticket-edit-menu"] });
        }}
      />
      <MenuPhotoEditor
        open={photoEditorOpen}
        items={data?.menu ?? []}
        offline={!online}
        loadIssue={data?.cacheError}
        onClose={() => setPhotoEditorOpen(false)}
        onSaved={() => {
          setPhotoEditorOpen(false);
          void qc.invalidateQueries({ queryKey: ["menu"] });
        }}
      />
      <Dialog open={!!receipt} onOpenChange={(open) => !open && setReceipt(null)}>
        <DialogContent className="max-h-[90vh] max-w-md overflow-y-auto border-[#4A3831] bg-[#1D130E]/95 text-[#FAF0E6] backdrop-blur-xl">
          <DialogHeader>
            <DialogTitle className="font-display text-2xl text-[#FAF0E6]">Order ticket</DialogTitle>
          </DialogHeader>
          {receipt && (
            <div
              id="pos-receipt-print"
              className="receipt-print mx-auto w-full max-w-xs rounded-lg bg-[#F8F1E7] p-5 font-mono text-sm text-[#241812] shadow-lg"
            >
              <div className="text-center">
                <div className="font-display text-2xl font-bold">CantiLounge</div>
                <div className="mt-1 text-xs">Where books meet brews.</div>
                <div className="mt-3 border-t border-dashed border-[#9A8576] pt-3 text-xs">
                  <div className="font-bold">
                    {receipt.orderNumber === null
                      ? "OFFLINE ORDER — PENDING SYNC"
                      : `ORDER #${receipt.orderNumber}`}
                  </div>
                  {receipt.orderNumber !== null && (
                    <div className="mt-1 font-bold">
                      {receipt.paymentMethod
                        ? `PAID · ${receipt.paymentMethod === "GCASH" ? "GCASH" : "CASH"}`
                        : "PAYMENT PENDING"}
                    </div>
                  )}
                  {receipt.paymentReference && <div>GCash ref: {receipt.paymentReference}</div>}
                  <div>{new Date(receipt.createdAt).toLocaleString()}</div>
                  <div>{receipt.orderType.replace("_", " ")}</div>
                  {receipt.customer && <div>Customer: {receipt.customer}</div>}
                </div>
              </div>

              <div className="my-3 space-y-2 border-y border-dashed border-[#9A8576] py-3">
                {receipt.items.map((line) => (
                  <div key={line.key}>
                    <div className="flex justify-between gap-2">
                      <span className="min-w-0 flex-1">
                        {line.qty} × {line.item.name}
                      </span>
                      <span>{peso((line.item.base_price + line.modPrice) * line.qty)}</span>
                    </div>
                    {line.modifiers && (
                      <div className="pl-4 text-[10px] text-[#625248]">
                        {line.modifiers.size && `${line.modifiers.size} · `}
                        Sugar {line.modifiers.sugar} · Ice {line.modifiers.ice} ·{" "}
                        {line.modifiers.milk} milk
                        {line.modifiers.syrup && line.modifiers.syrup !== "none"
                          ? ` · ${line.modifiers.syrup} syrup`
                          : ""}
                      </div>
                    )}
                  </div>
                ))}
              </div>

              <div className="space-y-1">
                <Row label="Subtotal" value={peso(receipt.subtotal)} />
                {receipt.discount > 0 && (
                  <Row
                    label={`${receipt.discountType} discount`}
                    value={`−${peso(receipt.discount)}`}
                  />
                )}
                <div className="flex justify-between border-t border-[#9A8576] pt-2 font-bold">
                  <span>Total</span>
                  <span>{peso(receipt.total)}</span>
                </div>
                {receipt.cashReceived !== null && (
                  <>
                    <Row label="Cash received" value={peso(receipt.cashReceived)} />
                    <Row
                      label={receipt.cashReceived >= receipt.total ? "Change" : "Amount due"}
                      value={peso(Math.abs(receipt.cashReceived - receipt.total))}
                    />
                  </>
                )}
                {receipt.paymentMethod === "GCASH" && <Row label="Payment" value="GCash" />}
              </div>
              <div className="mt-4 border-t border-dashed border-[#9A8576] pt-3 text-center text-xs">
                Thank you for visiting!
              </div>
            </div>
          )}
          <div className="flex gap-2 pt-2">
            <Button
              variant="outline"
              onClick={() => setReceipt(null)}
              className="flex-1 border-[#4A3831] bg-transparent text-[#C8B6A6] hover:bg-[#2A1C16] hover:text-[#FAF0E6]"
            >
              Close
            </Button>
            <Button
              onClick={() => window.print()}
              className="flex-1 bg-[#D4A373] font-bold text-[#1A120F] hover:bg-[#C28E5E]"
            >
              <Printer className="mr-2 size-4" />
              Print ticket
            </Button>
          </div>
        </DialogContent>
      </Dialog>
      <style>{`
        @media print {
          body * { visibility: hidden !important; }
          #pos-receipt-print, #pos-receipt-print * { visibility: visible !important; }
          #pos-receipt-print {
            position: absolute !important;
            inset: 0 auto auto 0 !important;
            width: 80mm !important;
            max-width: 80mm !important;
            margin: 0 !important;
            border-radius: 0 !important;
            box-shadow: none !important;
            print-color-adjust: exact;
            -webkit-print-color-adjust: exact;
          }
        }
      `}</style>
    </div>
  );
}

type EditableTicketItem = {
  draftId: string;
  id: string | null;
  menu_item_id: string;
  name: string;
  quantity: number;
  item_price: number;
  modifiers: Modifiers | null;
  item_status: "PENDING" | "IN_PREP" | "READY" | "COMPLETED" | "CANCELLED";
  station: "BARISTA" | "KITCHEN";
};

export function TicketEditor({
  order,
  onClose,
  onSaved,
}: {
  order: {
    id: string;
    order_number: number;
    discount_type: string | null;
  } | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const notifyLowStock = useServerFn(sendLowStockAlerts);
  const notifyVoid = useServerFn(sendVoidAlert);
  const [draft, setDraft] = useState<EditableTicketItem[]>([]);
  const [reason, setReason] = useState("");
  const [newItemId, setNewItemId] = useState("");
  const [saving, setSaving] = useState(false);
  const {
    data: items,
    isLoading,
    isError,
  } = useQuery({
    queryKey: ["ticket-edit-items", order?.id],
    enabled: !!order,
    queryFn: async () => {
      if (!order) return [];
      const { data, error } = await mysql
        .from("order_items")
        .select("id, menu_item_id, name, quantity, item_price, modifiers, item_status, station")
        .eq("order_id", order.id);
      if (error) throw error;
      return data.map((item) => ({
        ...item,
        draftId: item.id,
        modifiers: item.modifiers as Modifiers | null,
      }));
    },
  });
  const { data: menuItems } = useQuery({
    queryKey: ["ticket-edit-menu"],
    enabled: !!order,
    queryFn: async () => {
      const { data, error } = await mysql
        .from("menu_items")
        .select("id, name, base_price, target_station")
        .eq("is_available", true)
        .order("name");
      if (error) throw error;
      return data;
    },
  });

  useEffect(() => {
    setDraft(
      (items ?? []).map((item) => ({
        ...item,
        draftId: item.id ?? crypto.randomUUID(),
        id: item.id,
        quantity: item.item_status === "CANCELLED" ? 0 : item.quantity,
        modifiers: item.modifiers as Modifiers | null,
      })),
    );
  }, [items]);

  const addMenuItem = () => {
    const menuItem = menuItems?.find((item) => item.id === newItemId);
    if (!menuItem) return;
    setDraft((current) => [
      ...current,
      {
        draftId: crypto.randomUUID(),
        id: null,
        menu_item_id: menuItem.id,
        name: menuItem.name,
        quantity: 1,
        item_price: Number(menuItem.base_price),
        modifiers: null,
        item_status: "PENDING",
        station: menuItem.target_station,
      },
    ]);
    setNewItemId("");
  };

  const save = async () => {
    if (!order) return;
    setSaving(true);
    const { error } = await mysql.rpc("modify_order", {
      _order_id: order.id,
      _items: draft.map((item) => ({
        id: item.id,
        menu_item_id: item.menu_item_id,
        quantity: item.quantity,
        modifiers: item.modifiers,
      })),
    });
    setSaving(false);
    if (error) {
      toast.error(error.message);
      return;
    }
    void notifyLowStock().catch((notificationError: unknown) =>
      toast.error(
        `Ticket updated, but inventory email alert failed: ${errorMessage(notificationError)}`,
      ),
    );
    toast.success(`Order #${order.order_number} updated`);
    onSaved();
  };

  const voidTicket = async () => {
    if (!order || !reason) return;
    setSaving(true);
    const { error } = await mysql.rpc("void_order", { _order_id: order.id, _reason: reason });
    setSaving(false);
    if (error) {
      toast.error(error.message);
      return;
    }
    void notifyVoid({ data: { orderId: order.id } }).catch((notificationError: unknown) =>
      toast.error(
        `Ticket voided, but owner email alert failed: ${errorMessage(notificationError)}`,
      ),
    );
    toast.success(`Order #${order.order_number} voided`);
    onSaved();
  };

  return (
    <Dialog open={!!order} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto border-[#4A3831] bg-[#1D130E]/95 text-[#FAF0E6] sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="font-display text-2xl">
            Edit ticket #{order?.order_number}
          </DialogTitle>
        </DialogHeader>
        {isError ? (
          <p role="alert" className="text-sm text-rose-200">
            Could not load this ticket.
          </p>
        ) : isLoading ? (
          <p className="text-sm text-[#C8B6A6]">Loading ticket items…</p>
        ) : (
          <div className="space-y-3">
            <div className="flex flex-col gap-2 sm:flex-row">
              <select
                aria-label="Add a menu item to the order"
                value={newItemId}
                onChange={(event) => setNewItemId(event.target.value)}
                className="h-10 flex-1 rounded-lg border border-[#4A3831] bg-[#211712] px-3 text-sm text-[#FAF0E6]"
              >
                <option value="">Choose a menu item to add</option>
                {(menuItems ?? []).map((menuItem) => (
                  <option key={menuItem.id} value={menuItem.id}>
                    {menuItem.name} · {peso(Number(menuItem.base_price))}
                  </option>
                ))}
              </select>
              <Button
                type="button"
                variant="outline"
                disabled={!newItemId}
                onClick={addMenuItem}
                className="h-10 border-[#D4A373]/40 text-[#E9B988]"
              >
                <Plus className="mr-2 size-4" />
                Add item
              </Button>
            </div>
            {draft.map((item) => (
              <div
                key={item.draftId}
                className="rounded-xl border border-[#442E24] bg-[#120B09]/60 p-3"
              >
                <div className="flex items-center gap-3">
                  <div className="min-w-0 flex-1">
                    <p className="font-semibold">{item.name}</p>
                    <p className="text-xs text-[#A98D7D]">
                      {item.item_status === "CANCELLED" || item.quantity === 0
                        ? "Voided line"
                        : `${peso(item.item_price)} each`}
                    </p>
                  </div>
                  <Button
                    size="icon"
                    variant="outline"
                    aria-label={`Decrease ${item.name} quantity`}
                    className="size-10 border-[#4A3831] bg-[#1E1512]"
                    onClick={() =>
                      setDraft((current) =>
                        current.map((line) =>
                          line.draftId === item.draftId
                            ? { ...line, quantity: Math.max(0, line.quantity - 1) }
                            : line,
                        ),
                      )
                    }
                  >
                    <Minus className="size-4" />
                  </Button>
                  <span className="w-6 text-center font-mono">{item.quantity}</span>
                  <Button
                    size="icon"
                    variant="outline"
                    aria-label={`Increase ${item.name} quantity`}
                    className="size-10 border-[#4A3831] bg-[#1E1512]"
                    onClick={() =>
                      setDraft((current) =>
                        current.map((line) =>
                          line.draftId === item.draftId
                            ? { ...line, quantity: line.quantity + 1, item_status: "PENDING" }
                            : line,
                        ),
                      )
                    }
                  >
                    <Plus className="size-4" />
                  </Button>
                </div>
                {item.station === "BARISTA" && item.quantity > 0 && (
                  <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-[#442E24] pt-3">
                    {(["size", "sugar", "ice", "milk", "syrup"] as const).map((modifier) => {
                      const options =
                        modifier === "sugar"
                          ? ["0%", "25%", "50%", "75%", "100%"]
                          : modifier === "ice"
                            ? ["none", "less", "regular", "hot"]
                            : modifier === "milk"
                              ? ["fresh", "oat"]
                              : modifier === "size"
                                ? ["small", "regular", "large"]
                                : ["none", "vanilla", "caramel", "hazelnut"];
                      return (
                        <label
                          key={modifier}
                          className="flex items-center gap-1.5 text-xs text-[#C8B6A6]"
                        >
                          <span className="capitalize">{modifier}</span>
                          <select
                            value={item.modifiers?.[modifier] ?? ""}
                            aria-label={`${item.name} ${modifier}`}
                            onChange={(event) => {
                              const value = event.target.value;
                              setDraft((current) =>
                                current.map((line) =>
                                  line.draftId === item.draftId
                                    ? (() => {
                                        const modifiers = value
                                          ? {
                                              sugar: line.modifiers?.sugar ?? "100%",
                                              ice: line.modifiers?.ice ?? "regular",
                                              milk: line.modifiers?.milk ?? "fresh",
                                              size: line.modifiers?.size ?? "regular",
                                              syrup: line.modifiers?.syrup ?? "none",
                                              [modifier]: value,
                                            }
                                          : null;
                                        const basePrice =
                                          line.item_price -
                                          (line.modifiers?.milk === "oat" ? OAT_UPCHARGE : 0);
                                        return {
                                          ...line,
                                          modifiers,
                                          item_price:
                                            basePrice +
                                            (modifiers?.milk === "oat" ? OAT_UPCHARGE : 0),
                                        };
                                      })()
                                    : line,
                                ),
                              );
                            }}
                            className="h-9 rounded-lg border border-[#4A3831] bg-[#211712] px-2 text-[#FAF0E6]"
                          >
                            <option value="">Default</option>
                            {options.map((option) => (
                              <option key={option} value={option}>
                                {option}
                              </option>
                            ))}
                          </select>
                        </label>
                      );
                    })}
                    {item.modifiers && (
                      <button
                        className="text-xs text-[#E9B988] underline underline-offset-2"
                        onClick={() =>
                          setDraft((current) =>
                            current.map((line) =>
                              line.draftId === item.draftId
                                ? {
                                    ...line,
                                    modifiers: null,
                                    item_price:
                                      line.item_price -
                                      (line.modifiers?.milk === "oat" ? OAT_UPCHARGE : 0),
                                  }
                                : line,
                            ),
                          )
                        }
                      >
                        Remove customization
                      </button>
                    )}
                  </div>
                )}
              </div>
            ))}
            {order &&
              (() => {
                const subtotal = draft.reduce(
                  (sum, item) => sum + (item.quantity > 0 ? item.item_price * item.quantity : 0),
                  0,
                );
                const discountRate =
                  order.discount_type === "STUDENT"
                    ? 0.1
                    : order.discount_type === "SENIOR"
                      ? 0.2
                      : 0;
                const discount = Math.round(subtotal * discountRate * 100) / 100;
                return (
                  <div className="space-y-1 rounded-xl border border-[#442E24] bg-[#120B09]/60 p-3 font-mono text-sm">
                    <Row label="Subtotal" value={peso(subtotal)} />
                    {discount > 0 && (
                      <Row label={`${order.discount_type} discount`} value={`−${peso(discount)}`} />
                    )}
                    <div className="flex justify-between border-t border-[#442E24] pt-2 font-bold text-[#E9B988]">
                      <span>Updated total</span>
                      <span>{peso(subtotal - discount)}</span>
                    </div>
                  </div>
                );
              })()}
            <div className="rounded-xl border border-rose-400/20 bg-rose-950/20 p-3">
              <div className="flex flex-col gap-2 sm:flex-row">
                <select
                  aria-label="Reason for voiding ticket"
                  value={reason}
                  onChange={(event) => setReason(event.target.value)}
                  className="h-10 flex-1 rounded-lg border border-[#4A3831] bg-[#211712] px-3 text-sm text-[#FAF0E6]"
                >
                  <option value="">Select a void reason</option>
                  <option>Customer Changed Mind</option>
                  <option>Cashier Misclick</option>
                  <option>Cashier Mistake</option>
                  <option>Out of Stock</option>
                  <option>Customer Cancelled</option>
                </select>
                <Button
                  variant="outline"
                  disabled={!reason || saving}
                  onClick={voidTicket}
                  className="h-10 border-rose-400/40 text-rose-200 hover:bg-rose-950/40"
                >
                  <Ban className="mr-2 size-4" />
                  Void entire ticket
                </Button>
              </div>
            </div>
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose} className="border-[#4A3831]">
            Cancel
          </Button>
          <Button disabled={saving || isLoading || isError || draft.length === 0} onClick={save}>
            {saving && <Loader2 className="mr-2 size-4 animate-spin" />}
            Update Order
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function MerchantQrCode() {
  return (
    <div className="rounded-xl border border-[#4A3831] bg-[#120B09]/70 p-3 text-center">
      {MERCHANT_GCASH_QR_URL ? (
        <img
          src={MERCHANT_GCASH_QR_URL}
          alt="CantiLounge official GCash merchant QR code"
          className="mx-auto size-40 rounded-lg border-2 border-[#B85D19]/50 bg-[#EAE2D8] object-contain p-1"
        />
      ) : (
        <div className="mx-auto grid size-40 place-items-center rounded-lg border-2 border-dashed border-[#B85D19]/50 bg-[#EAE2D8] px-3 text-[#7D421F]">
          <div>
            <WalletCards className="mx-auto size-8" />
            <span className="mt-2 block text-[10px] font-bold uppercase tracking-wide">
              Merchant QR not set
            </span>
          </div>
        </div>
      )}
      {!MERCHANT_GCASH_QR_URL && (
        <p className="mt-2 text-xs text-amber-100">
          Configure <code>(placeholder)need qr sa gcash</code> with the cafe&apos;s official QR
          image.
        </p>
      )}
    </div>
  );
}

type TenderMethod = "CASH" | "GCASH" | "SPLIT";

export function TenderDialog({
  order,
  onClose,
  onSettled,
}: {
  order: { id: string; order_number: number; total_amount: number } | null;
  onClose: () => void;
  onSettled: () => void;
}) {
  const [method, setMethod] = useState<TenderMethod>("CASH");
  const [cashValue, setCashValue] = useState("");
  const [reference, setReference] = useState("");
  const [saving, setSaving] = useState(false);
  const [paid, setPaid] = useState(false);
  const total = order?.total_amount ?? 0;
  const cash = Math.round(Number(cashValue || 0) * 100) / 100;
  const gcashAmount =
    method === "GCASH"
      ? total
      : method === "SPLIT"
        ? Math.max(0, Math.round((total - cash) * 100) / 100)
        : 0;
  const referenceValid = !reference.trim() || /^\d{4,13}$/.test(reference);
  const merchantQrUrl = import.meta.env["VITE_GCASH_QR_IMAGE_URL"]?.trim();
  const ready =
    !!order &&
    !saving &&
    !paid &&
    (method === "CASH"
      ? cash >= total
      : method === "GCASH"
        ? referenceValid
        : cash >= 0 && cash < total && referenceValid);

  useEffect(() => {
    setMethod("CASH");
    setCashValue(order?.total_amount.toFixed(2) ?? "");
    setReference("");
    setPaid(false);
  }, [order]);

  const settle = async () => {
    if (!order || !ready) return;
    setSaving(true);
    const { error } = await mysql.rpc("settle_order", {
      _order_id: order.id,
      _payment_method: method,
      _cash_received: method === "GCASH" ? 0 : cash,
      _gcash_amount: gcashAmount,
      _gcash_reference: method === "CASH" ? null : reference.trim() || null,
    });
    if (error) {
      setSaving(false);
      toast.error(error.message);
      return;
    }
    const { data: savedOrder, error: verificationError } = await mysql
      .from("orders")
      .select("status, settled_at, payment_method")
      .eq("id", order.id)
      .maybeSingle();
    setSaving(false);
    if (verificationError) {
      toast.error(`Payment was submitted but could not be verified: ${verificationError.message}`);
      return;
    }
    if (
      !savedOrder?.settled_at ||
      savedOrder.status !== "COMPLETED" ||
      savedOrder.payment_method !== method
    ) {
      toast.error("Payment was submitted but the ticket is not marked as completed.");
      return;
    }
    toast.success(
      method === "GCASH"
        ? `Payment Received via GCash [Ref: ${reference}]`
        : `Order #${order.order_number} payment recorded`,
    );
    setPaid(true);
    onSettled();
  };

  return (
    <Dialog open={!!order} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto border-[#4A3831] bg-[#1D130E]/95 text-[#FAF0E6] sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="font-display text-2xl">
            {paid ? "Payment recorded" : `Checkout · Order #${order?.order_number}`}
          </DialogTitle>
        </DialogHeader>
        {order &&
          (paid ? (
            <div
              id="tender-receipt"
              className="rounded-xl bg-[#F8F1E7] p-5 font-mono text-sm text-[#241812]"
            >
              <div className="text-center">
                <p className="font-display text-2xl font-bold">CantiLounge</p>
                <p className="mt-2">Order #{order.order_number}</p>
                <p className="mt-3 border-t border-dashed border-[#9A8576] pt-3">
                  TOTAL {peso(total)}
                </p>
                <p>Payment: {method}</p>
                {method !== "CASH" && <p>GCash reference: {reference}</p>}
                {method !== "CASH" && <p>GCash amount: {peso(gcashAmount)}</p>}
                {method !== "GCASH" && <p>Cash received: {peso(cash)}</p>}
                <p className="mt-3 border-t border-dashed border-[#9A8576] pt-3">
                  Thank you for visiting!
                </p>
              </div>
            </div>
          ) : (
            <div className="space-y-4">
              <div className="flex justify-between rounded-xl border border-[#442E24] bg-[#120B09]/60 p-3 font-mono">
                <span className="text-[#C8B6A6]">Amount due</span>
                <strong className="text-[#E9B988]">{peso(total)}</strong>
              </div>
              <div className="grid grid-cols-3 gap-2">
                {(["CASH", "GCASH", "SPLIT"] as const).map((option) => (
                  <button
                    key={option}
                    onClick={() => {
                      setMethod(option);
                      setCashValue(
                        option === "SPLIT"
                          ? (total / 2).toFixed(2)
                          : option === "CASH"
                            ? total.toFixed(2)
                            : "0",
                      );
                    }}
                    className={`min-h-11 rounded-xl border text-xs font-semibold tracking-[0.12em] ${method === option ? "border-[#D4A373] bg-[#D4A373] text-[#1A120F]" : "border-[#4A3831] bg-[#251A15] text-[#C8B6A6]"}`}
                  >
                    {option === "GCASH" ? "GCash" : option === "CASH" ? "Cash" : "Split"}
                  </button>
                ))}
              </div>
              {method !== "CASH" && (
                <div className="rounded-2xl border border-[#4A3831] bg-[#120B09]/70 p-4">
                  {merchantQrUrl ? (
                    <img
                      src={merchantQrUrl}
                      alt="CantiLounge official GCash merchant QR code"
                      className="mx-auto size-36 rounded-lg border-2 border-[#B85D19]/50 bg-[#EAE2D8] object-contain p-1"
                    />
                  ) : (
                    <>
                      <div
                        className="mx-auto grid size-36 place-items-center rounded-lg border-2 border-dashed border-[#B85D19]/50 bg-[#EAE2D8] text-[#7D421F]"
                        aria-label="GCash merchant QR placeholder"
                      >
                        <div className="text-center">
                          <WalletCards className="mx-auto size-8" />
                          <span className="mt-2 block text-[10px] font-bold uppercase tracking-wide">
                            Merchant QR
                          </span>
                          <span className="text-[9px]">not configured</span>
                        </div>
                      </div>
                      <p className="mt-3 text-center text-[10px] font-bold uppercase tracking-[0.2em] text-[#E9B988]">
                        QR not configured
                      </p>
                      <p className="mt-1 text-center text-xs text-[#C8B6A6]">
                        Set VITE_GCASH_QR_IMAGE_URL to the official merchant QR image.
                      </p>
                    </>
                  )}
                  <p className="mt-2 text-center font-mono text-lg font-semibold text-[#FAF0E6]">
                    {peso(gcashAmount)}
                  </p>
                </div>
              )}
              {method !== "GCASH" && (
                <label className="block space-y-1.5 text-sm">
                  <span>{method === "SPLIT" ? "Cash portion" : "Cash received"}</span>
                  <Input
                    type="number"
                    min="0"
                    step="0.01"
                    inputMode="decimal"
                    value={cashValue}
                    onChange={(event) => setCashValue(event.target.value)}
                    className="border-[#442E24] bg-[#120B09]/80 font-mono"
                  />
                  {method === "SPLIT" && (
                    <span className="block text-xs text-[#C8B6A6]">
                      GCash portion: {peso(gcashAmount)}
                    </span>
                  )}
                </label>
              )}
              {method !== "CASH" && (
                <label className="block space-y-1.5 text-sm">
                  <span>GCash Reference Number (optional)</span>
                  <Input
                    inputMode="numeric"
                    maxLength={13}
                    placeholder="Optional · 4–13 digits"
                    value={reference}
                    onChange={(event) =>
                      setReference(event.target.value.replace(/\D/g, "").slice(0, 13))
                    }
                    className="border-[#442E24] bg-[#120B09]/80 font-mono"
                  />
                  <span className="text-xs text-[#A98D7D]">
                    Enter the reference shown in the GCash payment receipt.
                  </span>
                </label>
              )}
            </div>
          ))}
        <DialogFooter>
          {paid ? (
            <>
              <Button variant="outline" onClick={onClose} className="border-[#4A3831]">
                Close
              </Button>
              <Button
                onClick={() => window.print()}
                className="bg-[#D4A373] text-[#1A120F] hover:bg-[#C28E5E]"
              >
                <Printer className="mr-2 size-4" />
                Print payment receipt
              </Button>
            </>
          ) : (
            <Button disabled={!ready} onClick={settle} className="w-full">
              {saving && <Loader2 className="mr-2 size-4 animate-spin" />}
              {method === "GCASH" ? "Confirm Payment" : "Complete Payment"}
            </Button>
          )}
        </DialogFooter>
        <style>{`
          @media print {
            body * { visibility: hidden !important; }
            #tender-receipt, #tender-receipt * { visibility: visible !important; }
            #tender-receipt { position: absolute !important; inset: 0 auto auto 0 !important; width: 80mm !important; margin: 0 !important; }
          }
        `}</style>
      </DialogContent>
    </Dialog>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between text-muted-foreground">
      <span>{label}</span>
      <span>{value}</span>
    </div>
  );
}

export function MenuItemManager({
  open,
  items,
  categories,
  offline,
  loadIssue,
  onClose,
  onChanged,
}: {
  open: boolean;
  items: CachedMenuItem[];
  categories: CachedCategory[];
  offline: boolean;
  loadIssue?: string | undefined;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [name, setName] = useState("");
  const [price, setPrice] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const [station, setStation] = useState<"BARISTA" | "KITCHEN">("BARISTA");
  const [isAvailable, setIsAvailable] = useState(true);
  const [editingItemId, setEditingItemId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [busyItemId, setBusyItemId] = useState<string | null>(null);
  const sortedItems = useMemo(
    () =>
      [...items].sort(
        (a, b) => Number(b.is_active) - Number(a.is_active) || a.name.localeCompare(b.name),
      ),
    [items],
  );

  useEffect(() => {
    const firstCategory = categories[0];
    if (firstCategory && !categories.some((category) => category.id === categoryId)) {
      setCategoryId(firstCategory.id);
    }
  }, [categories, categoryId]);

  const resetForm = () => {
    setName("");
    setPrice("");
    setStation("BARISTA");
    setIsAvailable(true);
    setEditingItemId(null);
  };

  const editItem = (item: CachedMenuItem) => {
    setEditingItemId(item.id);
    setName(item.name);
    setPrice(String(item.base_price));
    setCategoryId(item.category_id);
    setStation(item.target_station);
    setIsAvailable(item.is_available);
  };

  const saveItem = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const parsedPrice = Number(price);
    if (!name.trim() || !categoryId || !Number.isFinite(parsedPrice) || parsedPrice <= 0) {
      toast.error("Enter an item name, category, and price greater than zero");
      return;
    }
    setSaving(true);
    try {
      const changes = {
        name: name.trim(),
        category_id: categoryId,
        base_price: Math.round(parsedPrice * 100) / 100,
        target_station: station,
        is_available: isAvailable,
      };
      const result = editingItemId
        ? await mysql.from("menu_items").update(changes).eq("id", editingItemId)
        : await mysql.from("menu_items").insert({ ...changes, is_active: true });
      if (result.error) {
        toast.error(
          /is_active|schema cache/i.test(result.error.message)
            ? "Apply migration 20261020130000_menu_item_management.sql before managing menu items."
            : result.error.message,
        );
        return;
      }
      toast.success(editingItemId ? `${name.trim()} updated` : `${name.trim()} added to the menu`);
      resetForm();
      onChanged();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not save menu item");
    } finally {
      setSaving(false);
    }
  };

  const removeItem = async (item: CachedMenuItem) => {
    if (!window.confirm(`Remove ${item.name} from the menu?`)) return;
    setBusyItemId(item.id);
    try {
      const [ordersResult, recipesResult] = await Promise.all([
        mysql.from("order_items").select("id").eq("menu_item_id", item.id).limit(1),
        mysql.from("recipe_ingredients").select("id").eq("menu_item_id", item.id).limit(1),
      ]);
      if (ordersResult.error || recipesResult.error) {
        toast.error(
          ordersResult.error?.message ??
            recipesResult.error?.message ??
            "Could not check menu item references",
        );
        return;
      }
      if (ordersResult.data.length || recipesResult.data.length) {
        const { error } = await mysql
          .from("menu_items")
          .update({ is_active: false })
          .eq("id", item.id);
        if (error) {
          toast.error(error.message);
          return;
        }
        toast.success(`${item.name} removed from the POS menu; existing records were preserved`);
      } else {
        const { error } = await mysql.from("menu_items").delete().eq("id", item.id);
        if (error) {
          toast.error(error.message);
          return;
        }
        toast.success(`${item.name} deleted`);
      }
      onChanged();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not remove menu item");
    } finally {
      setBusyItemId(null);
    }
  };

  const restoreItem = async (item: CachedMenuItem) => {
    setBusyItemId(item.id);
    try {
      const { error } = await mysql
        .from("menu_items")
        .update({ is_active: true })
        .eq("id", item.id);
      if (error) {
        toast.error(error.message);
        return;
      }
      toast.success(`${item.name} restored to the POS menu`);
      onChanged();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not restore menu item");
    } finally {
      setBusyItemId(null);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(isOpen) => !isOpen && onClose()}>
      <DialogContent className="w-[calc(100vw-1rem)] max-h-[calc(100dvh-1rem)] overflow-y-auto border-[#332017] bg-[#1C120E] p-4 text-[#FAF0E6] sm:w-full sm:max-h-[90vh] sm:max-w-2xl sm:rounded-lg sm:p-6">
        <DialogHeader>
          <DialogTitle className="pr-8 font-display text-xl sm:text-2xl">
            Manage menu items
          </DialogTitle>
        </DialogHeader>
        {offline ? (
          <p role="alert" className="text-sm text-amber-200">
            Connect to the internet to add, remove, or restore menu items.
          </p>
        ) : (
          <div className="space-y-5">
            {loadIssue && (
              <p role="status" className="text-sm text-amber-100">
                The live menu did not load ({loadIssue}). You can still try menu changes; errors
                will be shown when saving.
              </p>
            )}
            {categories.length === 0 && (
              <p role="alert" className="text-sm text-amber-200">
                No categories are loaded. Check the menu connection and refresh before adding an
                item.
              </p>
            )}
            <form
              onSubmit={(event) => void saveItem(event)}
              className="space-y-3 rounded-2xl border border-[#442E24] bg-[#120B09]/60 p-3 sm:p-4"
            >
              <h3 className="text-xs font-semibold uppercase tracking-[0.16em] text-[#E9B988]">
                {editingItemId ? "Edit menu item" : "Add a drink or menu item"}
              </h3>
              <div className="grid gap-3 sm:grid-cols-2">
                <Input
                  required
                  maxLength={100}
                  placeholder="Item name"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  className="border-[#3A261D] bg-[#1C120E]"
                />
                <Input
                  required
                  type="number"
                  min="0.01"
                  step="0.01"
                  placeholder="Price (₱)"
                  value={price}
                  onChange={(event) => setPrice(event.target.value)}
                  className="border-[#3A261D] bg-[#1C120E] font-mono"
                />
                <select
                  required
                  aria-label="Menu item category"
                  value={categoryId}
                  onChange={(event) => setCategoryId(event.target.value)}
                  className="h-10 min-w-0 rounded-md border border-[#3A261D] bg-[#1C120E] px-3 text-sm"
                >
                  {categories.map((category) => (
                    <option key={category.id} value={category.id}>
                      {category.name}
                    </option>
                  ))}
                </select>
                <select
                  aria-label="Menu item station"
                  value={station}
                  onChange={(event) => setStation(event.target.value as "BARISTA" | "KITCHEN")}
                  className="h-10 min-w-0 rounded-md border border-[#3A261D] bg-[#1C120E] px-3 text-sm"
                >
                  <option value="BARISTA">Barista</option>
                  <option value="KITCHEN">Kitchen</option>
                </select>
              </div>
              <label className="flex items-center gap-2 text-sm text-[#C8B6A6]">
                <input
                  type="checkbox"
                  checked={isAvailable}
                  onChange={(event) => setIsAvailable(event.target.checked)}
                  className="size-4 accent-[#B85D19]"
                />
                In stock and available on the POS
              </label>
              <div className="grid grid-cols-1 gap-2 sm:flex sm:flex-wrap">
                <Button
                  type="submit"
                  disabled={saving || categories.length === 0}
                  className="w-full sm:w-auto"
                >
                  {saving ? (
                    <Loader2 className="mr-2 size-4 animate-spin" />
                  ) : (
                    <Plus className="mr-2 size-4" />
                  )}
                  {editingItemId ? "Save changes" : "Add item"}
                </Button>
                {editingItemId && (
                  <Button
                    type="button"
                    variant="outline"
                    disabled={saving}
                    onClick={resetForm}
                    className="w-full border-[#4A3831] sm:w-auto"
                  >
                    Cancel edit
                  </Button>
                )}
              </div>
            </form>
            <section className="space-y-2">
              <h3 className="text-xs font-semibold uppercase tracking-[0.16em] text-[#A98D7D]">
                Current and removed items
              </h3>
              {sortedItems.length ? (
                <ul className="max-h-64 space-y-2 overflow-y-auto">
                  {sortedItems.map((item) => (
                    <li
                      key={item.id}
                      className="flex flex-col gap-3 rounded-xl border border-[#442E24] bg-[#120B09]/50 p-3 sm:flex-row sm:items-center"
                    >
                      <div className="min-w-0 flex-1">
                        <p className="truncate font-medium text-[#FAF0E6]">{item.name}</p>
                        <p className="text-xs text-[#A98D7D]">
                          {peso(item.base_price)} ·{" "}
                          {categories.find((category) => category.id === item.category_id)?.name ??
                            "Menu"}
                          {item.is_available ? " · in stock" : " · out of stock"}
                          {!item.is_active && " · removed"}
                        </p>
                      </div>
                      {item.is_active && (
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          disabled={busyItemId === item.id}
                          onClick={() => editItem(item)}
                          className="w-full border-[#D4A373]/40 text-[#E9B988] sm:w-auto"
                        >
                          <Pencil className="mr-1.5 size-4" />
                          Edit
                        </Button>
                      )}
                      {item.is_active ? (
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          disabled={busyItemId === item.id}
                          onClick={() => void removeItem(item)}
                          className="w-full border-rose-400/35 text-rose-200 hover:bg-rose-950/40 sm:w-auto"
                        >
                          {busyItemId === item.id ? (
                            <Loader2 className="size-4 animate-spin" />
                          ) : (
                            <Archive className="mr-1.5 size-4" />
                          )}
                          Remove
                        </Button>
                      ) : (
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          disabled={busyItemId === item.id}
                          onClick={() => void restoreItem(item)}
                          className="w-full border-[#D4A373]/40 text-[#E9B988] sm:w-auto"
                        >
                          {busyItemId === item.id ? (
                            <Loader2 className="size-4 animate-spin" />
                          ) : (
                            "Restore"
                          )}
                        </Button>
                      )}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-[#A98D7D]">No menu items yet.</p>
              )}
            </section>
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose} className="w-full border-[#4A3831] sm:w-auto">
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function MenuPhotoEditor({
  open,
  items,
  offline,
  loadIssue,
  onClose,
  onSaved,
}: {
  open: boolean;
  items: CachedMenuItem[];
  offline: boolean;
  loadIssue?: string | undefined;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [itemId, setItemId] = useState("");
  const [imageUrl, setImageUrl] = useState("");
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [saving, setSaving] = useState(false);
  const selected = items.find((item) => item.id === itemId) ?? items[0];
  const previewUrl = useMemo(
    () => (imageFile ? URL.createObjectURL(imageFile) : imageUrl.trim() || null),
    [imageFile, imageUrl],
  );

  useEffect(() => {
    if (open && items.length && !items.some((item) => item.id === itemId)) {
      const firstItem = items[0];
      if (firstItem) setItemId(firstItem.id);
    }
  }, [open, items, itemId]);

  useEffect(() => {
    setImageUrl(selected?.image_url ?? "");
    setImageFile(null);
  }, [selected?.id, selected?.image_url]);

  useEffect(() => {
    if (imageFile && previewUrl) return () => URL.revokeObjectURL(previewUrl);
    return undefined;
  }, [imageFile, previewUrl]);

  const save = async () => {
    if (!selected || offline) return;
    setSaving(true);
    try {
      let nextImageUrl = imageUrl.trim() || null;
      if (imageFile) {
        const extensions: Record<string, string> = {
          "image/jpeg": "jpg",
          "image/png": "png",
          "image/webp": "webp",
          "image/avif": "avif",
        };
        const extension = extensions[imageFile.type];
        if (!extension) throw new Error("Use a JPEG, PNG, WebP, or AVIF image");
        if (imageFile.size > 5 * 1024 * 1024) throw new Error("Image must be 5 MB or smaller");
        nextImageUrl = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onerror = () => reject(new Error("Could not read the selected image"));
          reader.onload = () => {
            if (typeof reader.result !== "string") {
              reject(new Error("Could not encode the selected image"));
              return;
            }
            resolve(reader.result);
          };
          reader.readAsDataURL(imageFile);
        });
      }

      const { error } = await mysql
        .from("menu_items")
        .update({ image_url: nextImageUrl })
        .eq("id", selected.id);
      if (error) throw error;
      toast.success(`${selected.name} photo updated`);
      onSaved();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Unable to save menu photo");
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!selected || offline) return;
    setSaving(true);
    try {
      const { error } = await mysql
        .from("menu_items")
        .update({ image_url: null })
        .eq("id", selected.id);
      if (error) throw error;
      setImageFile(null);
      setImageUrl("");
      toast.success(`${selected.name} photo removed`);
      onSaved();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not remove menu photo");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(isOpen) => !isOpen && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto border-[#332017] bg-[#1C120E] text-[#FAF0E6] sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="font-display text-2xl">Edit menu photos</DialogTitle>
        </DialogHeader>
        {offline ? (
          <p role="alert" className="text-sm text-amber-200">
            Connect to the internet to update menu photos.
          </p>
        ) : items.length === 0 ? (
          <p role="status" className="text-sm text-[#C8B6A6]">
            No menu items are loaded. Check the menu connection and try again.
          </p>
        ) : (
          <div className="space-y-4">
            {loadIssue && (
              <p role="status" className="text-sm text-amber-100">
                The live menu did not load ({loadIssue}). Saving may fail until the connection is
                restored.
              </p>
            )}
            <label className="block space-y-2 text-sm">
              <span>Drink or menu item</span>
              <select
                value={selected?.id ?? ""}
                onChange={(event) => setItemId(event.target.value)}
                className="h-11 w-full rounded-lg border border-[#4A3831] bg-[#211712] px-3 text-[#FAF0E6]"
              >
                {items.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="block space-y-2 text-sm">
              <span>Photo URL or public asset path</span>
              <Input
                type="text"
                placeholder="/images/iced-latte.jpg"
                value={imageFile ? "" : imageUrl}
                onChange={(event) => {
                  setImageFile(null);
                  setImageUrl(event.target.value);
                }}
                className="border-[#3A261D] bg-[#120B09]"
              />
              <span className="block text-xs text-[#A98D7D]">
                Use a public image URL or a file path under the app’s public folder.
              </span>
            </label>
            <label className="block space-y-2 text-sm">
              <span>Or upload an image</span>
              <Input
                type="file"
                accept="image/*"
                onChange={(event) => {
                  const file = event.target.files?.[0] ?? null;
                  if (file && file.size > 5 * 1024 * 1024) {
                    toast.error("Choose an image smaller than 5 MB");
                    event.target.value = "";
                    return;
                  }
                  if (
                    file &&
                    !["image/jpeg", "image/png", "image/webp", "image/avif"].includes(file.type)
                  ) {
                    toast.error("Use a JPEG, PNG, WebP, or AVIF image");
                    event.target.value = "";
                    return;
                  }
                  setImageFile(file);
                }}
                className="border-[#3A261D] bg-[#120B09] file:mr-3 file:rounded-md file:border-0 file:bg-[#B85D19] file:px-3 file:py-1.5 file:text-[#FAF0E6]"
              />
              <span className="block text-xs text-[#A98D7D]">
                Images are stored in the menu-photos bucket (5 MB maximum).
              </span>
            </label>
            <div className="overflow-hidden rounded-xl border border-[#3A261D] bg-[#38271E]">
              {previewUrl ? (
                <img
                  src={previewUrl}
                  alt={selected?.name ?? "Menu item preview"}
                  loading="lazy"
                  className="aspect-square w-full object-cover"
                  onError={(event) => {
                    if (!event.currentTarget.src.endsWith("/cafee.avif")) {
                      event.currentTarget.src = "/cafee.avif";
                    }
                  }}
                />
              ) : (
                <div className="grid aspect-[4/3] place-items-center bg-[radial-gradient(circle_at_center,#38271E,#211712)] text-[#D4A373]">
                  <Coffee className="size-14 opacity-70" aria-hidden="true" />
                </div>
              )}
            </div>
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose} className="border-[#4A3831]">
            Cancel
          </Button>
          <Button
            variant="outline"
            disabled={
              offline || !selected || saving || (!selected.image_url && !imageUrl && !imageFile)
            }
            onClick={remove}
            className="border-rose-400/40 text-rose-200 hover:bg-rose-950/40"
          >
            Remove Photo
          </Button>
          <Button disabled={offline || !selected || saving} onClick={save}>
            {saving && <Loader2 className="mr-2 size-4 animate-spin" />}
            Save Image
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ModifierDialog({
  item,
  initialModifiers,
  onClose,
  onAdd,
}: {
  item: CachedMenuItem | null;
  initialModifiers: Modifiers | null;
  onClose: () => void;
  onAdd: (m: Modifiers) => void;
}) {
  const [m, setM] = useState<Modifiers>({
    sugar: "100%",
    ice: "regular",
    milk: "fresh",
    size: "regular",
    syrup: "none",
  });
  useEffect(() => {
    if (item)
      setM({
        sugar: initialModifiers?.sugar ?? "100%",
        ice: initialModifiers?.ice ?? "regular",
        milk: initialModifiers?.milk ?? "fresh",
        size: initialModifiers?.size ?? "regular",
        syrup: initialModifiers?.syrup ?? "none",
        notes: initialModifiers?.notes ?? "",
      });
  }, [initialModifiers, item]);
  const groups: { key: keyof Modifiers; label: string; opts: string[] }[] = [
    { key: "size", label: "Size", opts: ["small", "regular", "large"] },
    { key: "sugar", label: "Sugar", opts: ["0%", "25%", "50%", "75%", "100%"] },
    { key: "ice", label: "Ice", opts: ["none", "less", "regular", "hot"] },
    { key: "milk", label: "Milk", opts: ["fresh", "oat"] },
    { key: "syrup", label: "Syrup", opts: ["none", "vanilla", "caramel", "hazelnut"] },
  ];
  return (
    <Dialog open={!!item} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="font-display text-2xl">{item?.name}</DialogTitle>
        </DialogHeader>
        {groups.map((g) => (
          <div key={g.key}>
            <div className="mb-2 text-sm text-muted-foreground">{g.label}</div>
            <div className="flex flex-wrap gap-2">
              {g.opts.map((o) => (
                <button
                  key={o}
                  onClick={() => setM({ ...m, [g.key]: o })}
                  className={`rounded-lg border px-3 py-2 text-sm capitalize ${m[g.key] === o ? "border-primary bg-primary text-primary-foreground" : ""}`}
                >
                  {o}
                  {g.key === "milk" && o === "oat" ? ` +${peso(OAT_UPCHARGE)}` : ""}
                </button>
              ))}
            </div>
          </div>
        ))}
        <label className="block space-y-2 text-sm">
          <span>Order notes</span>
          <Input
            maxLength={120}
            placeholder="e.g. extra hot, no cinnamon"
            value={m.notes ?? ""}
            onChange={(event) => setM({ ...m, notes: event.target.value })}
          />
        </label>
        <DialogFooter>
          <Button className="w-full" onClick={() => onAdd(m)}>
            Add to order
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
