import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { Loader2, Plus } from "lucide-react";
import { toast } from "sonner";
import { mysql } from "@/integrations/mysql/client";
import { createStaff, resetStaffPin } from "@/lib/staff.functions";
import { ROLES, type Role, peso } from "@/lib/staff-auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";

export const Route = createFileRoute("/_authenticated/staff")({
  head: () => ({
    meta: [
      { title: "Staff — CantiLounge Hub" },
      { name: "description", content: "Manage Cantilounge staff accounts, roles, PINs and rates." },
      { property: "og:title", content: "Staff — CantiLounge Hub" },
      { property: "og:description", content: "Team roster and access roles." },
    ],
  }),
  component: StaffPage,
});

function StaffPage() {
  const qc = useQueryClient();
  const create = useServerFn(createStaff);
  const resetPin = useServerFn(resetStaffPin);
  const { data } = useQuery({
    queryKey: ["staff"],
    queryFn: async () => {
      const { data, error } = await mysql
        .from("staff_profiles")
        .select("id, full_name, staff_code, hourly_rate, is_active, user_roles(role)")
        .order("full_name");
      if (error) throw error;
      return data;
    },
  });
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [f, setF] = useState({
    fullName: "",
    staffCode: "",
    pin: "",
    hourlyRate: "80",
    roles: ["CASHIER"] as Role[],
  });

  const submit = async () => {
    setBusy(true);
    try {
      await create({ data: { ...f, hourlyRate: Number(f.hourlyRate) } });
      toast.success(`${f.fullName} added`);
      setOpen(false);
      setF({ fullName: "", staffCode: "", pin: "", hourlyRate: "80", roles: ["CASHIER"] });
      qc.invalidateQueries({ queryKey: ["staff"] });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed");
    } finally {
      setBusy(false);
    }
  };

  const setActive = async (id: string, v: boolean) => {
    const { error } = await mysql.from("staff_profiles").update({ is_active: v }).eq("id", id);
    if (error) toast.error(error.message);
    else qc.invalidateQueries({ queryKey: ["staff"] });
  };

  const doReset = async (id: string, name: string) => {
    const pin = window.prompt(`New 4–6 digit PIN for ${name}`);
    if (!pin) return;
    try {
      await resetPin({ data: { userId: id, pin } });
      toast.success("PIN updated");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed");
    }
  };

  return (
    <div className="p-6">
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-3xl">Staff</h1>
        <Button onClick={() => setOpen(true)}>
          <Plus />
          Add staff
        </Button>
      </div>
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {data?.map((s) => (
          <div
            key={s.id}
            className={`rounded-2xl border bg-card p-5 ${s.is_active ? "" : "opacity-50"}`}
          >
            <div className="flex items-start justify-between">
              <div className="flex items-center gap-3">
                <div className="grid size-11 place-items-center rounded-full bg-secondary font-display text-lg text-crema">
                  {s.full_name.charAt(0)}
                </div>
                <div>
                  <div className="font-semibold">{s.full_name}</div>
                  <div className="font-mono text-xs uppercase text-muted-foreground">
                    {s.staff_code} · {peso(s.hourly_rate)}/hr
                  </div>
                </div>
              </div>
              <Switch checked={s.is_active} onCheckedChange={(v) => setActive(s.id, v)} />
            </div>
            <div className="mt-4 flex flex-wrap gap-1.5">
              {(s.user_roles ?? []).map((r) => (
                <span
                  key={r.role}
                  className="rounded-full bg-primary/15 px-2.5 py-0.5 text-[11px] font-semibold text-primary"
                >
                  {r.role}
                </span>
              ))}
            </div>
            <Button
              size="sm"
              variant="ghost"
              className="mt-3"
              onClick={() => doReset(s.id, s.full_name)}
            >
              Reset PIN
            </Button>
          </div>
        ))}
      </div>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add staff member</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label>Full name</Label>
              <Input
                value={f.fullName}
                onChange={(e) => setF({ ...f, fullName: e.target.value })}
              />
            </div>
            <div className="grid grid-cols-3 gap-2">
              <div>
                <Label>Staff code</Label>
                <Input
                  value={f.staffCode}
                  onChange={(e) => setF({ ...f, staffCode: e.target.value })}
                />
              </div>
              <div>
                <Label>PIN</Label>
                <Input
                  type="password"
                  inputMode="numeric"
                  value={f.pin}
                  onChange={(e) =>
                    setF({ ...f, pin: e.target.value.replace(/\D/g, "").slice(0, 6) })
                  }
                />
              </div>
              <div>
                <Label>₱ / hour</Label>
                <Input
                  type="number"
                  value={f.hourlyRate}
                  onChange={(e) => setF({ ...f, hourlyRate: e.target.value })}
                />
              </div>
            </div>
            <div>
              <Label>Roles</Label>
              <div className="mt-2 flex flex-wrap gap-2">
                {ROLES.map((r) => {
                  const on = f.roles.includes(r);
                  return (
                    <button
                      key={r}
                      type="button"
                      onClick={() =>
                        setF({ ...f, roles: on ? f.roles.filter((x) => x !== r) : [...f.roles, r] })
                      }
                      className={`rounded-lg border px-3 py-1.5 text-xs font-semibold ${on ? "border-primary bg-primary text-primary-foreground" : ""}`}
                    >
                      {r}
                    </button>
                  );
                })}
              </div>
            </div>
            <Button
              className="w-full"
              disabled={busy || !f.fullName || !f.staffCode || f.pin.length < 4 || !f.roles.length}
              onClick={submit}
            >
              {busy && <Loader2 className="animate-spin" />}Create account
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
