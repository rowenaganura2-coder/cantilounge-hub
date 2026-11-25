import { createFileRoute, Outlet, redirect, Link, useNavigate } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import {
  ChartNoAxesCombined,
  ClipboardList,
  Clock,
  Coffee,
  Menu,
  LogOut,
  Package,
  ReceiptText,
  ShoppingBag,
  Users,
  Wifi,
  WifiOff,
  RefreshCw,
} from "lucide-react";
import { signOutStaff } from "@/integrations/mysql/auth.functions";
import { loadStaffSession, clearStaffSessionCache } from "@/lib/session";
import { startSyncListeners, useSync } from "@/lib/sync";
import { hasAny, type Role } from "@/lib/staff-auth";
import { CafeLogo } from "@/components/cafe-logo";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";

export const Route = createFileRoute("/_authenticated")({
  ssr: false,
  beforeLoad: async () => {
    const staff = await loadStaffSession();
    if (!staff) throw redirect({ to: "/" });
    return { staff };
  },
  component: Shell,
});

const NAV: {
  to: "/pos" | "/inventory" | "/staff" | "/clock" | "/analytics" | "/orders" | "/audit-logs";
  label: string;
  icon: typeof Coffee;
  roles: Role[];
}[] = [
  { to: "/pos", label: "POS", icon: ShoppingBag, roles: ["ADMIN", "MANAGER", "CASHIER"] },
  { to: "/orders", label: "Orders", icon: ReceiptText, roles: ["ADMIN", "MANAGER", "CASHIER"] },
  { to: "/analytics", label: "Income", icon: ChartNoAxesCombined, roles: ["ADMIN"] },
  { to: "/audit-logs", label: "Audit", icon: ClipboardList, roles: ["ADMIN"] },
  { to: "/inventory", label: "Stock", icon: Package, roles: ["ADMIN", "MANAGER"] },
  { to: "/staff", label: "Staff", icon: Users, roles: ["ADMIN", "MANAGER"] },
  {
    to: "/clock",
    label: "Clock",
    icon: Clock,
    roles: ["ADMIN", "MANAGER", "CASHIER", "BARISTA", "KITCHEN"],
  },
];

function Shell() {
  const { staff } = Route.useRouteContext();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { online, pending, syncing, flush } = useSync();
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  useEffect(() => startSyncListeners(), []);

  const signOut = async () => {
    await qc.cancelQueries();
    qc.clear();
    clearStaffSessionCache();
    await signOutStaff();
    navigate({ to: "/", replace: true });
  };

  return (
    <div className="flex min-h-screen min-w-0 flex-col bg-[#100A08]/90 sm:flex-row">
      <header className="sticky top-0 z-40 flex h-12 w-full items-center justify-between border-b border-[#2D1B14] bg-[#100A08]/95 px-3 backdrop-blur-md sm:hidden">
        <div className="flex min-w-0 items-center gap-2">
          <div className="grid size-8 shrink-0 place-items-center overflow-hidden rounded-lg bg-[#1B120F] ring-1 ring-[#4A3831]">
            <CafeLogo className="size-7 object-cover" />
          </div>
          <span className="truncate font-display text-sm text-[#FAF0E6]">CantiLounge Hub</span>
        </div>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Open navigation menu"
          aria-expanded={mobileMenuOpen}
          onClick={() => setMobileMenuOpen(true)}
          className="size-10 text-[#FAF0E6]"
        >
          <Menu className="size-5" />
        </Button>
      </header>
      <Sheet open={mobileMenuOpen} onOpenChange={setMobileMenuOpen}>
        <SheetContent
          side="left"
          className="w-[min(18rem,85vw)] border-[#2D1B14] bg-[#100A08] p-5 text-[#FAF0E6] sm:hidden"
        >
          <SheetTitle className="mb-6 flex items-center gap-3 pr-8 font-display text-xl">
            <CafeLogo className="size-10 rounded-lg object-cover" />
            CantiLounge Hub
          </SheetTitle>
          <nav className="flex flex-col gap-2">
            {NAV.filter((item) => hasAny(staff.roles, item.roles)).map((item) => (
              <Link
                key={item.to}
                to={item.to}
                onClick={() => setMobileMenuOpen(false)}
                className="flex min-h-12 items-center gap-3 rounded-xl px-3 text-sm font-medium text-[#C8B6A6] transition hover:bg-sidebar-accent hover:text-[#FAF0E6]"
                activeProps={{
                  className: "bg-sidebar-accent text-sidebar-primary font-semibold",
                }}
              >
                <item.icon className="size-5 shrink-0" />
                {item.label}
              </Link>
            ))}
          </nav>
          <div className="absolute inset-x-5 bottom-5 space-y-4 border-t border-[#2D1B14] pt-4">
            <button
              onClick={() => void flush()}
              title={online ? "Online" : "Offline — orders are saved on this device"}
              className={`flex min-h-10 items-center gap-3 text-sm ${online ? "text-success" : "text-warning"}`}
            >
              {syncing ? (
                <RefreshCw className="size-4 animate-spin" />
              ) : online ? (
                <Wifi className="size-4" />
              ) : (
                <WifiOff className="size-4" />
              )}
              {pending > 0 ? `${pending} queued` : online ? "Online" : "Offline"}
            </button>
            <div className="flex items-center justify-between gap-3">
              <span className="min-w-0 truncate text-sm text-[#C8B6A6]">{staff.fullName}</span>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => void signOut()}
                className="shrink-0 text-[#C8B6A6] hover:text-destructive"
              >
                <LogOut className="mr-2 size-4" />
                Sign out
              </Button>
            </div>
          </div>
        </SheetContent>
      </Sheet>
      <aside className="sticky top-0 hidden h-screen w-20 shrink-0 flex-col items-center gap-2 border-r border-[#2D1B14] bg-[#100A08]/90 py-4 backdrop-blur-md sm:flex">
        <div className="mb-4 overflow-hidden rounded-xl bg-[#1B120F] shadow-glow ring-1 ring-[#4A3831]">
          <CafeLogo className="size-11 object-cover" />
        </div>
        {NAV.filter((n) => hasAny(staff.roles, n.roles)).map((n) => (
          <Link
            key={n.to}
            to={n.to}
            className="flex w-16 flex-col items-center gap-1 rounded-xl py-2.5 text-[11px] font-medium text-sidebar-foreground/70 transition hover:bg-sidebar-accent"
            activeProps={{ className: "bg-sidebar-accent text-sidebar-primary" }}
          >
            <n.icon className="size-5" />
            {n.label}
          </Link>
        ))}
        <div className="mt-auto flex flex-col items-center gap-3">
          <button
            onClick={() => flush()}
            title={online ? "Online" : "Offline — orders are saved on this device"}
            className={`flex w-16 flex-col items-center gap-1 rounded-xl py-2 text-[10px] ${online ? "text-success" : "text-warning"}`}
          >
            {syncing ? (
              <RefreshCw className="size-4 animate-spin" />
            ) : online ? (
              <Wifi className="size-4" />
            ) : (
              <WifiOff className="size-4" />
            )}
            {pending > 0 ? `${pending} queued` : online ? "Online" : "Offline"}
          </button>
          <div
            className="grid size-10 place-items-center rounded-full bg-secondary font-display text-crema"
            title={staff.fullName}
          >
            {staff.fullName.charAt(0)}
          </div>
          <button
            onClick={signOut}
            className="text-muted-foreground hover:text-destructive"
            title="Sign out"
          >
            <LogOut className="size-5" />
          </button>
        </div>
      </aside>
      <main className="min-w-0 flex-1">
        <Outlet />
      </main>
    </div>
  );
}
