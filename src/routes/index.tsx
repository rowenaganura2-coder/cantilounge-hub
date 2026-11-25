import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useState } from "react";
import { Coffee, Delete, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { mysql } from "@/integrations/mysql/client";
import { signInStaff } from "@/integrations/mysql/auth.functions";
import { loadStaffSession, homeFor } from "@/lib/session";
import { bootstrapOwner } from "@/lib/staff.functions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { CafeLogo } from "@/components/cafe-logo";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Staff Sign In — CantiLounge Hub" },
      {
        name: "description",
        content: "Tap your name and enter your PIN to start your shift at Cantilounge.",
      },
      { property: "og:title", content: "Staff Sign In — CantiLounge Hub" },
      { property: "og:description", content: "PIN sign-in for Cantilounge cafe staff." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: LoginPage,
});

type LoginStaff = { id: string; full_name: string; staff_code: string };

function LoginPage() {
  const navigate = useNavigate();
  const [selected, setSelected] = useState<LoginStaff | null>(null);
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    loadStaffSession().then((s) => s && navigate({ to: homeFor(s.roles) }));
  }, [navigate]);

  const staff = useQuery({
    queryKey: ["login-staff"],
    queryFn: async () => {
      const { data, error } = await mysql.rpc("list_login_staff");
      if (error) throw error;
      return data as LoginStaff[];
    },
  });

  const submit = async (code: string) => {
    if (!selected) return;
    setBusy(true);
    try {
      await signInStaff({ data: { staffCode: selected.staff_code, pin: code } });
    } catch {
      setBusy(false);
      setPin("");
      toast.error("Wrong PIN");
      return;
    }
    const s = await loadStaffSession();
    setBusy(false);
    if (!s) {
      const { signOutStaff } = await import("@/integrations/mysql/auth.functions");
      await signOutStaff();
      toast.error("Account inactive");
      return;
    }
    toast.success(`Welcome, ${s.fullName.split(" ")[0]}`);
    navigate({ to: homeFor(s.roles) });
  };

  const press = (d: string) => {
    if (busy) return;
    const next = (pin + d).slice(0, 6);
    setPin(next);
  };

  return (
    <div className="min-h-screen bg-[#1A120F] text-[#F5EBE0]">
      <div className="mx-auto grid min-h-screen max-w-7xl grid-cols-1 gap-6 px-4 py-6 sm:px-6 lg:grid-cols-12 lg:px-10 lg:py-10">
        <section className="lg:col-span-7">
          <header className="mb-8 flex items-center gap-3">
            <div className="flex h-12 w-28 items-center justify-center overflow-hidden rounded-xl bg-[#F5EBE0]/5 ring-1 ring-[#5A3E31]/70 backdrop-blur-sm">
              <CafeLogo className="h-10 w-auto object-contain" />
            </div>
            <div>
              <h1 className="text-2xl font-bold tracking-tight text-[#F5EBE0]">CantiLounge Hub</h1>
              <p className="text-sm text-[#C8B6A6]">Staff Sign In</p>
            </div>
          </header>

          <div className="rounded-[28px] border border-[#5A3E31]/80 bg-[#2A1F1B]/60 p-4 shadow-[0_30px_80px_rgba(0,0,0,0.28)] backdrop-blur-md sm:p-5 lg:p-6">
            {staff.isLoading ? (
              <div className="grid min-h-[420px] place-items-center">
                <Loader2 className="animate-spin text-[#D4A373]" />
              </div>
            ) : staff.data && staff.data.length === 0 ? (
              <>
                <OwnerSetup onDone={() => staff.refetch()} />
                <div className="mt-6 text-center">
                  <button
                    type="button"
                    className="text-sm text-[#DCC7B3] transition hover:text-[#F5EBE0]"
                    onClick={() => navigate({ to: "/signup" })}
                  >
                    Need to create the owner account? Sign up
                  </button>
                </div>
              </>
            ) : !selected ? (
              <section>
                <div className="mb-5 flex items-end justify-between gap-3">
                  <div>
                    <p className="text-xs uppercase tracking-[0.25em] text-[#D4A373]">Clock in</p>
                    <h2 className="mt-2 font-display text-4xl text-[#FAF0E6] sm:text-5xl">Who's on shift?</h2>
                  </div>
                  <button
                    type="button"
                    className="rounded-full border border-[#D4A373]/30 bg-[#D4A373]/10 px-3 py-1.5 text-xs font-semibold text-[#E9B988] transition hover:border-[#D4A373]/60 hover:bg-[#D4A373]/15"
                    onClick={() => navigate({ to: "/signup" })}
                  >
                    Sign up
                  </button>
                </div>
                <p className="mb-6 max-w-xl text-sm text-[#C8B6A6]">
                  Select your profile or enter your quick PIN to clock in.
                </p>
                <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
                  {staff.data?.map((s) => (
                    <button
                      key={s.id}
                      onClick={() => setSelected(s)}
                      className="group relative overflow-hidden rounded-2xl border border-[#4A3831] bg-[#2C1E18]/70 p-4 text-left shadow-[inset_0_1px_0_rgba(255,255,255,0.02)] transition duration-200 hover:-translate-y-0.5 hover:border-[#D4A373] hover:bg-[#352620]/80 hover:shadow-[0_18px_36px_rgba(0,0,0,0.18)]"
                    >
                      <div className="mb-4 flex items-center justify-between">
                        <div className="grid size-11 place-items-center rounded-full bg-[#D4A373]/20 font-display text-xl text-[#F7D9AE] ring-1 ring-[#D4A373]/25">
                          {s.full_name.charAt(0)}
                        </div>
                        <span className="rounded-full border border-[#D4A373]/25 bg-[#D4A373]/10 px-2 py-0.5 text-[9px] uppercase tracking-[0.2em] text-[#E9B988]">
                          On
                        </span>
                      </div>
                      <div className="font-semibold text-[#FAF0E6]">{s.full_name}</div>
                      <div className="mt-1 font-mono text-[10px] uppercase tracking-[0.18em] text-[#C8B6A6]">
                        {s.staff_code}
                      </div>
                    </button>
                  ))}
                  {Array.from({ length: Math.max(0, 6 - (staff.data?.length ?? 0) % 6) }).map((_, i) => (
                    <div
                      key={`placeholder-${i}`}
                      className="flex min-h-[150px] items-center justify-center rounded-2xl border border-dashed border-[#5A3E31] bg-[#201916]/40 text-center text-[10px] uppercase tracking-[0.2em] text-[#8B7367]"
                    >
                      Open shift
                    </div>
                  ))}
                </div>
              </section>
            ) : (
              <section className="mx-auto max-w-sm py-10 text-center">
                <button
                  className="text-sm text-[#C8B6A6] transition hover:text-[#F5EBE0]"
                  onClick={() => {
                    setSelected(null);
                    setPin("");
                  }}
                >
                  ← Not {selected.full_name.split(" ")[0]}?
                </button>
                <h2 className="mt-4 font-display text-4xl text-[#FAF0E6]">{selected.full_name}</h2>
                <p className="mt-2 text-sm text-[#C8B6A6]">Enter your 4–6 digit PIN</p>
                <div className="my-7 flex justify-center gap-3">
                  {Array.from({ length: 6 }).map((_, i) => (
                    <span
                      key={i}
                      className={`size-3.5 rounded-full border ${i < pin.length ? "border-[#D4A373] bg-[#D4A373]" : "border-[#5A3E31] bg-transparent"}`}
                    />
                  ))}
                </div>
                <div className="grid grid-cols-3 gap-3">
                  {["1", "2", "3", "4", "5", "6", "7", "8", "9"].map((d) => (
                    <PinKey key={d} onClick={() => press(d)}>
                      {d}
                    </PinKey>
                  ))}
                  <PinKey onClick={() => setPin(pin.slice(0, -1))}>
                    <Delete className="mx-auto size-5" />
                  </PinKey>
                  <PinKey onClick={() => press("0")}>0</PinKey>
                  <button
                    disabled={pin.length < 4 || busy}
                    onClick={() => submit(pin)}
                    className="h-16 rounded-2xl bg-[#D4A373] font-semibold text-[#1E1512] shadow-[0_8px_20px_rgba(212,163,115,0.28)] transition hover:bg-[#E0AF7E] disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    {busy ? <Loader2 className="mx-auto animate-spin" /> : "Go"}
                  </button>
                </div>
              </section>
            )}
          </div>
        </section>

        <aside className="lg:col-span-5">
          <div className="relative flex min-h-[420px] h-full items-center justify-center overflow-hidden rounded-[30px] border border-[#5A3E31] bg-[#F5EDE0] p-6 text-[#2A1F1B] shadow-[0_30px_80px_rgba(0,0,0,0.24)] lg:min-h-[640px] lg:p-8">
            <div className="absolute inset-6 rounded-[24px] border border-[#D8B38A]/70 bg-[#F8F1E7]/70" />
            <div className="relative z-10 flex w-full max-w-md flex-col items-center text-center">
              <div className="mb-4 rotate-[-4deg] rounded-[24px] border border-[#5A3E31]/20 bg-[#F1E4D0] p-3 shadow-[0_18px_30px_rgba(73,52,48,0.12)]">
                <CafeLogo className="h-24 w-auto object-contain" />
              </div>
              <p className="text-xs uppercase tracking-[0.35em] text-[#6B4F3E]">Coffee • Books • Community</p>
              <h3 className="mt-4 font-display text-4xl leading-none text-[#2A1F1B]">Where books meet brews.</h3>
              <p className="mt-4 max-w-sm text-sm text-[#4E3A32]">
                A warm corner for slow pours, handwritten notes, and the rhythm of the shift.
              </p>
              <div className="mt-6 flex items-center gap-3 text-[#6B4F3E]">
                <span className="h-px w-10 bg-[#A57C56]" />
                <span className="font-mono text-[10px] uppercase tracking-[0.22em]">Open all day</span>
                <span className="h-px w-10 bg-[#A57C56]" />
              </div>
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}

function PinKey({ children, onClick }: { children: React.ReactNode; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="h-16 rounded-2xl border bg-card font-mono text-2xl transition active:scale-95 active:bg-accent"
    >
      {children}
    </button>
  );
}

function OwnerSetup({ onDone }: { onDone: () => void }) {
  const run = useServerFn(bootstrapOwner);
  const [f, setF] = useState({ fullName: "", staffCode: "", pin: "", hourlyRate: "0" });
  const [busy, setBusy] = useState(false);
  return (
    <section className="mx-auto mt-12 w-full max-w-md rounded-2xl border bg-card p-6">
      <h2 className="text-2xl">Set up the owner account</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        No staff exist yet. Create the first admin to get started.
      </p>
      <form
        className="mt-6 space-y-4"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          try {
            await run({ data: { ...f, hourlyRate: Number(f.hourlyRate) } });
            toast.success("Owner created. Sign in with your PIN.");
            onDone();
          } catch (err) {
            toast.error(err instanceof Error ? err.message : "Setup failed");
          } finally {
            setBusy(false);
          }
        }}
      >
        <div>
          <Label>Full name</Label>
          <Input
            required
            value={f.fullName}
            onChange={(e) => setF({ ...f, fullName: e.target.value })}
          />
        </div>
        <div>
          <Label>Staff code</Label>
          <Input
            required
            placeholder="e.g. owner"
            value={f.staffCode}
            onChange={(e) => setF({ ...f, staffCode: e.target.value })}
          />
        </div>
        <div>
          <Label>PIN (4–6 digits)</Label>
          <Input
            required
            inputMode="numeric"
            type="password"
            value={f.pin}
            onChange={(e) => setF({ ...f, pin: e.target.value.replace(/\D/g, "").slice(0, 6) })}
          />
        </div>
        <Button className="w-full" disabled={busy}>
          {busy && <Loader2 className="animate-spin" />}Create owner
        </Button>
      </form>
    </section>
  );
}
