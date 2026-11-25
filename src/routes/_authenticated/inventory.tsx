import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { AlertTriangle, Minus, Plus, Settings2 } from "lucide-react";
import { toast } from "sonner";
import { mysql } from "@/integrations/mysql/client";
import type { Database } from "@/integrations/mysql/types";
import { MenuItemManager } from "@/routes/_authenticated/pos";
import { useSync } from "@/lib/sync";
import type { CachedCategory, CachedMenuItem } from "@/lib/offline-db";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { peso } from "@/lib/staff-auth";
import { sendLowStockAlerts } from "@/lib/notification.functions";

type Ingredient = Database["public"]["Tables"]["ingredients"]["Row"];

export const Route = createFileRoute("/_authenticated/inventory")({
  head: () => ({
    meta: [
      { title: "Inventory & Recipes — CantiLounge Hub" },
      {
        name: "description",
        content: "Track ingredient stock, recipes and menu costs at Cantilounge.",
      },
      { property: "og:title", content: "Inventory & Recipes — CantiLounge Hub" },
      { property: "og:description", content: "Stock levels, low-stock alerts and recipe costing." },
    ],
  }),
  component: InventoryPage,
});

function InventoryPage() {
  const online = useSync((state) => state.online);
  const qc = useQueryClient();
  const [menuManagerOpen, setMenuManagerOpen] = useState(false);
  const { data: categories, error: categoriesError } = useQuery({
    queryKey: ["menu-manager-categories"],
    queryFn: async () => {
      const { data, error } = await mysql
        .from("categories")
        .select("id, name, sort_order")
        .order("sort_order");
      if (error) throw error;
      return data as CachedCategory[];
    },
  });
  const { data: menuItems, error: menuItemsError } = useQuery({
    queryKey: ["menu-manager-items"],
    queryFn: async () => {
      const { data, error } = await mysql
        .from("menu_items")
        .select(
          "id, name, category_id, base_price, target_station, is_available, is_active, image_url",
        )
        .order("name");
      if (error) throw error;
      return data.map((item): CachedMenuItem => ({
        ...item,
        base_price: Number(item.base_price),
        makeable: null,
      }));
    },
  });
  const refreshMenu = () => {
    void qc.invalidateQueries({ queryKey: ["menu-manager-items"] });
    void qc.invalidateQueries({ queryKey: ["menu-manager-categories"] });
    void qc.invalidateQueries({ queryKey: ["menu-admin"] });
    void qc.invalidateQueries({ queryKey: ["menu"] });
  };

  return (
    <div className="min-w-0 p-3 sm:p-6">
      <h1 className="mb-4 text-2xl sm:mb-6 sm:text-3xl">Inventory & Recipes</h1>
      <Tabs defaultValue="stock">
        <TabsList className="grid h-auto w-full grid-cols-2">
          <TabsTrigger value="stock" className="px-2 text-xs sm:text-sm">
            Stock
          </TabsTrigger>
          <TabsTrigger value="menu" className="px-2 text-xs sm:text-sm">
            Menu & recipes
          </TabsTrigger>
        </TabsList>
        <TabsContent value="stock">
          <StockTab onManageMenu={() => setMenuManagerOpen(true)} />
        </TabsContent>
        <TabsContent value="menu">
          <MenuTab onManageMenu={() => setMenuManagerOpen(true)} />
        </TabsContent>
      </Tabs>
      <MenuItemManager
        open={menuManagerOpen}
        items={menuItems ?? []}
        categories={categories ?? []}
        offline={!online}
        loadIssue={menuItemsError?.message ?? categoriesError?.message ?? undefined}
        onClose={() => setMenuManagerOpen(false)}
        onChanged={refreshMenu}
      />
    </div>
  );
}

function useIngredients() {
  return useQuery({
    queryKey: ["ingredients"],
    queryFn: async () => {
      const { data, error } = await mysql.from("ingredients").select("*").order("name");
      if (error) throw error;
      return data;
    },
  });
}

function StockTab({ onManageMenu }: { onManageMenu: () => void }) {
  const qc = useQueryClient();
  const notifyLowStock = useServerFn(sendLowStockAlerts);
  const { data } = useIngredients();
  const [adj, setAdj] = useState<Ingredient | null>(null);
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("RESTOCK");
  const [adjusting, setAdjusting] = useState(false);
  const [adding, setAdding] = useState(false);
  const [n, setN] = useState({
    name: "",
    unit: "g",
    cost: "0",
    stock: "0",
    min: "0",
    expires: "",
  });
  const low = data?.filter((i) => Number(i.current_stock) <= Number(i.min_threshold)) ?? [];

  const submitAdj = async () => {
    if (!adj) return;
    const quantity = Number(amount);
    if (!Number.isFinite(quantity) || quantity <= 0) {
      toast.error("Enter an adjustment amount greater than zero");
      return;
    }
    if (reason !== "RESTOCK" && quantity > Number(adj.current_stock)) {
      toast.error("The adjustment cannot reduce stock below zero");
      return;
    }
    setAdjusting(true);
    try {
      const v = quantity * (reason === "RESTOCK" ? 1 : -1);
      const { error } = await mysql.rpc("adjust_stock", {
        _ingredient_id: adj.id,
        _change: v,
        _reason: reason,
      });
      if (error) {
        toast.error(error.message);
        return;
      }
      toast.success("Stock updated");
      void notifyLowStock().catch((notificationError: unknown) =>
        toast.error(
          `Stock updated, but inventory email alert failed: ${notificationError instanceof Error ? notificationError.message : String(notificationError)}`,
        ),
      );
      setAdj(null);
      setAmount("");
      qc.invalidateQueries({ queryKey: ["ingredients"] });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Unable to update ingredient stock");
    } finally {
      setAdjusting(false);
    }
  };

  const addIngredient = async () => {
    const { error } = await mysql.from("ingredients").insert({
      name: n.name,
      unit: n.unit,
      cost_per_unit: Number(n.cost),
      current_stock: Number(n.stock),
      min_threshold: Number(n.min),
      reorder_level: Number(n.min),
      expires_at: n.expires || null,
    });
    if (error) {
      toast.error(error.message);
      return;
    }
    setAdding(false);
    setN({ name: "", unit: "g", cost: "0", stock: "0", min: "0", expires: "" });
    qc.invalidateQueries({ queryKey: ["ingredients"] });
  };

  const updateExpiry = async (ingredientId: string, value: string) => {
    const { error } = await mysql
      .from("ingredients")
      .update({ expires_at: value || null })
      .eq("id", ingredientId);
    if (error) {
      toast.error(`Could not update expiration date: ${error.message}`);
      return;
    }
    qc.invalidateQueries({ queryKey: ["ingredients"] });
    void notifyLowStock().catch((notificationError: unknown) =>
      toast.error(
        `Expiration date saved, but inventory email alert failed: ${notificationError instanceof Error ? notificationError.message : String(notificationError)}`,
      ),
    );
  };

  return (
    <div className="mt-4 space-y-4">
      {low.length > 0 && (
        <div className="flex items-start gap-3 rounded-2xl border border-warning/50 bg-warning/10 p-4 text-sm">
          <AlertTriangle className="size-5 shrink-0 text-warning" />
          <div>
            <b className="text-warning">Low stock:</b> {low.map((l) => l.name).join(", ")}
          </div>
        </div>
      )}
      <div className="grid grid-cols-1 gap-2 sm:flex sm:flex-wrap sm:justify-end">
        <Button variant="outline" onClick={onManageMenu} className="w-full sm:w-auto">
          <Settings2 />
          Manage menus
        </Button>
        <Button onClick={() => setAdding(true)} className="w-full sm:w-auto">
          <Plus />
          Add ingredient
        </Button>
      </div>
      <div className="overflow-x-auto rounded-2xl border">
        <table className="w-full min-w-[640px] text-sm">
          <thead className="bg-secondary text-left text-xs uppercase text-muted-foreground">
            <tr>
              <th className="p-3">Ingredient</th>
              <th className="p-3">Stock</th>
              <th className="p-3">Min</th>
              <th className="p-3">Expires</th>
              <th className="p-3">Cost / unit</th>
              <th className="p-3">Value</th>
              <th className="p-3"></th>
            </tr>
          </thead>
          <tbody className="tabular">
            {data?.map((i) => {
              const isLow = Number(i.current_stock) <= Number(i.min_threshold);
              const pct = Math.min(
                100,
                (Number(i.current_stock) / Math.max(1, Number(i.min_threshold) * 3)) * 100,
              );
              return (
                <tr key={i.id} className="border-t">
                  <td className="p-3 font-medium">{i.name}</td>
                  <td className="p-3">
                    <div className={`font-mono ${isLow ? "text-warning" : ""}`}>
                      {Number(i.current_stock).toLocaleString()} {i.unit}
                    </div>
                    <div className="mt-1 h-1.5 w-28 rounded-full bg-secondary">
                      <div
                        className={`h-full rounded-full ${isLow ? "bg-warning" : "bg-success"}`}
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                  </td>
                  <td className="p-3 font-mono text-muted-foreground">
                    {Number(i.min_threshold).toLocaleString()}
                  </td>
                  <td className="p-3">
                    <Input
                      aria-label={`${i.name} expiration date`}
                      type="date"
                      value={i.expires_at ?? ""}
                      onChange={(event) => void updateExpiry(i.id, event.target.value)}
                      className="h-9 min-w-36 border-[#442E24] bg-[#120B09] text-xs [color-scheme:dark]"
                    />
                  </td>
                  <td className="p-3 font-mono">₱{Number(i.cost_per_unit).toFixed(4)}</td>
                  <td className="p-3 font-mono">
                    {peso(Number(i.cost_per_unit) * Number(i.current_stock))}
                  </td>
                  <td className="p-3 text-right">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        setAmount("");
                        setReason("RESTOCK");
                        setAdj(i);
                      }}
                    >
                      Adjust
                    </Button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <Dialog
        open={!!adj}
        onOpenChange={(o) => {
          if (!o && !adjusting) setAdj(null);
        }}
      >
        <DialogContent
          overlayClassName="bg-black/60 backdrop-blur-sm"
          className="w-[calc(100vw-1rem)] max-h-[calc(100dvh-1rem)] max-w-2xl gap-0 overflow-y-auto rounded-2xl border-[#4A3225] bg-[#1D130E]/90 p-4 text-[#FAF0E6] shadow-2xl backdrop-blur-xl sm:w-full sm:max-h-[90vh] sm:rounded-3xl sm:p-8"
        >
          {adj &&
            (() => {
              const currentStock = Number(adj.current_stock);
              const minimum = Number(adj.min_threshold);
              const target = Math.max(minimum * 8, 1);
              const progress = Math.min(100, Math.max(0, (currentStock / target) * 100));
              const isLow = currentStock <= minimum;
              const quantity = Number(amount) || 0;
              const nextStock = currentStock + quantity * (reason === "RESTOCK" ? 1 : -1);
              const step = adj.unit.toLowerCase() === "pcs" ? 1 : 0.1;
              const canSubmit =
                quantity > 0 &&
                Number.isFinite(quantity) &&
                (reason === "RESTOCK" || quantity <= currentStock) &&
                !adjusting;

              return (
                <>
                  <DialogHeader className="pr-8 text-left">
                    <DialogTitle className="font-display text-3xl text-[#FAF0E6] sm:text-4xl">
                      Adjust Ingredient Stock
                    </DialogTitle>
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      <span className="font-medium text-[#D4A373]">{adj.name}</span>
                      <span className="rounded-full border border-[#D4A373]/25 bg-[#D4A373]/10 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-[#D4A373]">
                        Inventory
                      </span>
                    </div>
                  </DialogHeader>

                  <div className="mt-7 rounded-2xl border border-[#442E24] bg-[#120B09]/65 p-4 sm:p-5">
                    <div className="mb-4 flex flex-row-reverse items-end justify-between gap-3">
                      <div>
                        <p className="text-xs uppercase tracking-[0.2em] text-[#C8B6A6]">
                          Current quantity
                        </p>
                        <p className="mt-1 font-mono text-3xl font-bold tabular-nums text-[#E9B988] sm:text-4xl">
                          {currentStock.toLocaleString(undefined, { maximumFractionDigits: 2 })}{" "}
                          <span className="text-lg font-medium">{adj.unit}</span>
                        </p>
                      </div>
                      <span
                        className={`mb-1 rounded-full border px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.16em] ${
                          isLow
                            ? "border-amber-500/30 bg-amber-500/10 text-amber-300"
                            : "border-emerald-500/30 bg-emerald-500/10 text-emerald-300"
                        }`}
                      >
                        {isLow ? "Low stock" : "Healthy"}
                      </span>
                    </div>
                    <div
                      className="relative h-3 overflow-hidden rounded-full bg-[#2D1B13]"
                      role="meter"
                      aria-label="Ingredient stock level"
                      aria-valuemin={0}
                      aria-valuemax={target}
                      aria-valuenow={Math.min(currentStock, target)}
                    >
                      <div
                        className={`h-full rounded-full transition-[width] duration-500 ${
                          isLow ? "bg-amber-400" : "bg-[#10B981]"
                        }`}
                        style={{ width: `${progress}%` }}
                      />
                    </div>
                    <div className="mt-2 flex justify-between gap-3 text-xs text-[#C8B6A6]">
                      <span>
                        Min: {minimum.toLocaleString()} {adj.unit}
                      </span>
                      <span className="text-right">
                        Max / Target: {target.toLocaleString()} {adj.unit}
                      </span>
                    </div>
                  </div>

                  <div className="mt-6 space-y-3">
                    <p className="text-sm font-semibold text-[#FAF0E6]">Adjustment type</p>
                    <div className="grid grid-cols-3 gap-2">
                      {["RESTOCK", "WASTE", "CORRECTION"].map((r) => (
                        <button
                          key={r}
                          type="button"
                          onClick={() => setReason(r)}
                          className={`rounded-xl border px-2 py-3 text-xs font-semibold transition sm:text-sm ${
                            reason === r
                              ? "border-[#D4A373] bg-[#D4A373]/15 text-[#E9B988]"
                              : "border-[#442E24] bg-[#2A1C16] text-[#C8B6A6] hover:border-[#D4A373]"
                          }`}
                        >
                          {r}
                        </button>
                      ))}
                    </div>
                    <p className="text-xs text-[#C8B6A6]">
                      {reason === "RESTOCK"
                        ? "This amount will be added to the current stock."
                        : "This amount will be removed from the current stock."}
                    </p>
                  </div>

                  <div className="mt-5">
                    <label
                      htmlFor="stock-adjustment-amount"
                      className="mb-2 block text-sm font-semibold text-[#FAF0E6]"
                    >
                      Quantity to {reason === "RESTOCK" ? "add" : "remove"} ({adj.unit})
                    </label>
                    <div className="grid grid-cols-[48px_minmax(0,1fr)_48px] gap-2">
                      <button
                        type="button"
                        aria-label="Decrease adjustment quantity"
                        disabled={adjusting}
                        onClick={() =>
                          setAmount((value) => Math.max(0, (Number(value) || 0) - step).toString())
                        }
                        className="grid size-12 place-items-center rounded-xl border border-[#442E24] bg-[#2A1C16] text-[#FAF0E6] transition hover:border-[#D4A373] disabled:opacity-50"
                      >
                        <Minus className="size-4" />
                      </button>
                      <Input
                        id="stock-adjustment-amount"
                        type="number"
                        min="0"
                        max={reason === "RESTOCK" ? undefined : currentStock}
                        step={step}
                        inputMode="decimal"
                        placeholder="0"
                        value={amount}
                        onChange={(e) => setAmount(e.target.value)}
                        disabled={adjusting}
                        className="h-12 border-[#442E24] bg-[#120B09]/80 text-center font-mono text-lg text-[#FAF0E6] placeholder:text-[#8B7367] focus-visible:ring-[#D4A373]"
                      />
                      <button
                        type="button"
                        aria-label="Increase adjustment quantity"
                        disabled={adjusting}
                        onClick={() => setAmount(((Number(amount) || 0) + step).toString())}
                        className="grid size-12 place-items-center rounded-xl border border-[#442E24] bg-[#2A1C16] text-[#FAF0E6] transition hover:border-[#D4A373] disabled:opacity-50"
                      >
                        <Plus className="size-4" />
                      </button>
                    </div>
                    <div className="mt-3 flex items-center justify-between rounded-xl border border-[#442E24]/70 bg-[#120B09]/50 px-3 py-2 text-xs">
                      <span className="text-[#C8B6A6]">New quantity</span>
                      <span className="font-mono font-semibold text-[#E9B988]">
                        {nextStock.toLocaleString(undefined, { maximumFractionDigits: 2 })}{" "}
                        {adj.unit}
                      </span>
                    </div>
                    {reason !== "RESTOCK" && quantity > currentStock && (
                      <p className="mt-2 text-xs text-rose-300">
                        Quantity to remove cannot exceed the current stock.
                      </p>
                    )}
                  </div>

                  <div className="mt-7 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                    <Button
                      type="button"
                      variant="outline"
                      disabled={adjusting}
                      onClick={() => setAdj(null)}
                      className="rounded-xl border-[#442E24] bg-transparent text-[#C8B6A6] hover:bg-[#2A1C16] hover:text-[#FAF0E6]"
                    >
                      Cancel
                    </Button>
                    <Button
                      type="button"
                      onClick={submitAdj}
                      disabled={!canSubmit}
                      className="rounded-xl bg-[#D4A373] px-6 font-bold text-[#1A120F] shadow-lg hover:bg-[#C28E5E] disabled:opacity-50"
                    >
                      {adjusting ? "Saving..." : "Save adjustment"}
                    </Button>
                  </div>
                </>
              );
            })()}
        </DialogContent>
      </Dialog>

      <Dialog open={adding} onOpenChange={setAdding}>
        <DialogContent className="w-[calc(100vw-1rem)] max-h-[calc(100dvh-1rem)] overflow-y-auto p-4 sm:w-full sm:p-6">
          <DialogHeader>
            <DialogTitle>New ingredient</DialogTitle>
          </DialogHeader>
          <Input
            placeholder="Name"
            value={n.name}
            onChange={(e) => setN({ ...n, name: e.target.value })}
          />
          <div className="grid grid-cols-2 gap-2">
            <Input
              placeholder="Unit (g, ml, pcs)"
              value={n.unit}
              onChange={(e) => setN({ ...n, unit: e.target.value })}
            />
            <Input
              type="number"
              placeholder="Cost per unit"
              value={n.cost}
              onChange={(e) => setN({ ...n, cost: e.target.value })}
            />
            <Input
              type="number"
              placeholder="Current stock"
              value={n.stock}
              onChange={(e) => setN({ ...n, stock: e.target.value })}
            />
            <Input
              type="number"
              placeholder="Low-stock level"
              value={n.min}
              onChange={(e) => setN({ ...n, min: e.target.value })}
            />
            <label className="col-span-2 space-y-1 text-xs text-muted-foreground">
              Expiration date
              <Input
                type="date"
                value={n.expires}
                onChange={(e) => setN({ ...n, expires: e.target.value })}
              />
            </label>
          </div>
          <Button onClick={addIngredient} disabled={!n.name}>
            Add
          </Button>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function MenuTab({ onManageMenu }: { onManageMenu: () => void }) {
  const qc = useQueryClient();
  const { data: ingredients } = useIngredients();
  const { data } = useQuery({
    queryKey: ["menu-admin"],
    queryFn: async () => {
      const { data, error } = await mysql
        .from("menu_items")
        .select(
          "id, name, base_price, is_available, target_station, categories(name), recipe_ingredients(id, quantity_req, ingredient_id, ingredients(name, unit, cost_per_unit))",
        )
        .order("name");
      if (error) throw error;
      return data;
    },
  });
  const [addFor, setAddFor] = useState<string | null>(null);
  const [ing, setIng] = useState("");
  const [qty, setQty] = useState("");
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["menu-admin"] });
    qc.invalidateQueries({ queryKey: ["menu"] });
  };

  const toggle = async (id: string, v: boolean) => {
    const { error } = await mysql.from("menu_items").update({ is_available: v }).eq("id", id);
    if (error) toast.error(error.message);
    else refresh();
  };
  const addRecipe = async () => {
    if (!addFor || !ing) return;
    const { error } = await mysql
      .from("recipe_ingredients")
      .upsert(
        { menu_item_id: addFor, ingredient_id: ing, quantity_req: Number(qty) },
        { onConflict: "menu_item_id,ingredient_id" },
      );
    if (error) {
      toast.error(error.message);
      return;
    }
    setAddFor(null);
    setIng("");
    setQty("");
    refresh();
  };
  const removeRecipe = async (id: string) => {
    const { error } = await mysql.from("recipe_ingredients").delete().eq("id", id);
    if (error) toast.error(error.message);
    else refresh();
  };

  return (
    <div className="mt-4 space-y-4">
      <div className="flex">
        <Button variant="outline" onClick={onManageMenu} className="w-full sm:ml-auto sm:w-auto">
          <Settings2 />
          Manage menus
        </Button>
      </div>
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {data?.map((m) => {
          const cost = (m.recipe_ingredients ?? []).reduce(
            (s, r) => s + Number(r.quantity_req) * Number(r.ingredients?.cost_per_unit ?? 0),
            0,
          );
          const margin =
            Number(m.base_price) > 0
              ? ((Number(m.base_price) - cost) / Number(m.base_price)) * 100
              : 0;
          return (
            <div key={m.id} className="rounded-2xl border bg-card p-4">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <div className="font-semibold">{m.name}</div>
                  <div className="text-xs text-muted-foreground">
                    {m.categories?.name} · {m.target_station}
                  </div>
                </div>
                <Switch checked={m.is_available} onCheckedChange={(v) => toggle(m.id, v)} />
              </div>
              <div className="mt-3 flex gap-4 font-mono text-sm tabular">
                <span>{peso(m.base_price)}</span>
                <span className="text-muted-foreground">cost {peso(cost)}</span>
                <span className={margin < 60 ? "text-warning" : "text-success"}>
                  {margin.toFixed(0)}%
                </span>
              </div>
              <ul className="mt-3 space-y-1 text-sm">
                {(m.recipe_ingredients ?? []).map((r) => (
                  <li
                    key={r.id}
                    className="group flex items-center justify-between gap-2 text-muted-foreground"
                  >
                    <span>{r.ingredients?.name}</span>
                    <span className="flex shrink-0 items-center font-mono">
                      {Number(r.quantity_req)} {r.ingredients?.unit}
                      <button
                        type="button"
                        aria-label={`Remove ${r.ingredients?.name ?? "ingredient"} from ${m.name} recipe`}
                        className="ml-2 grid size-8 place-items-center rounded-md text-lg text-destructive sm:size-6 sm:text-base sm:opacity-0 sm:group-hover:opacity-100"
                        onClick={() => removeRecipe(r.id)}
                      >
                        ×
                      </button>
                    </span>
                  </li>
                ))}
              </ul>
              <Button
                size="sm"
                variant="ghost"
                className="mt-2 min-h-10"
                onClick={() => setAddFor(m.id)}
              >
                <Plus />
                Ingredient
              </Button>
            </div>
          );
        })}
        <Dialog open={!!addFor} onOpenChange={(o) => !o && setAddFor(null)}>
          <DialogContent className="w-[calc(100vw-1rem)] max-h-[calc(100dvh-1rem)] overflow-y-auto p-4 sm:w-full sm:p-6">
            <DialogHeader>
              <DialogTitle>Add to recipe</DialogTitle>
            </DialogHeader>
            <select
              className="h-9 rounded-md border bg-background px-3 text-sm"
              value={ing}
              onChange={(e) => setIng(e.target.value)}
            >
              <option value="">Choose ingredient…</option>
              {ingredients?.map((i) => (
                <option key={i.id} value={i.id}>
                  {i.name} ({i.unit})
                </option>
              ))}
            </select>
            <Input
              type="number"
              placeholder="Quantity per serving"
              value={qty}
              onChange={(e) => setQty(e.target.value)}
            />
            <Button onClick={addRecipe} disabled={!ing || !qty}>
              Save
            </Button>
          </DialogContent>
        </Dialog>
      </div>
    </div>
  );
}
