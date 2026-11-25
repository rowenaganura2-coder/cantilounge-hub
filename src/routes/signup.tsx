import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { Coffee, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { bootstrapOwner } from "@/lib/staff.functions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { CafeLogo } from "@/components/cafe-logo";

export const Route = createFileRoute("/signup")({
  head: () => ({
    meta: [
      { title: "Sign Up — CantiLounge Hub" },
      { name: "description", content: "Create the first CantiLounge owner account." },
      { property: "og:title", content: "Sign Up — CantiLounge Hub" },
      { property: "og:description", content: "Create the first owner account." },
    ],
  }),
  component: SignupPage,
});

function SignupPage() {
  const navigate = useNavigate();
  const run = useServerFn(bootstrapOwner);
  const [f, setF] = useState({ fullName: "", staffCode: "", pin: "", hourlyRate: "0" });
  const [busy, setBusy] = useState(false);

  return (
    <div className="min-h-screen bg-hero">
      <div className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-6 py-10">
        <header className="mb-8 flex items-center gap-3">
          <div className="overflow-hidden rounded-xl bg-primary shadow-glow">
            <CafeLogo className="size-11 object-cover" />
          </div>
          <div>
            <h1 className="text-2xl font-bold">CantiLounge Hub</h1>
            <p className="text-sm text-muted-foreground">Create your account</p>
          </div>
        </header>

        <section className="rounded-2xl border bg-card p-6 shadow-sm">
          <h2 className="text-2xl font-semibold">Set up the owner account</h2>
          <p className="mt-2 text-sm text-muted-foreground">
            This creates the first admin account so your team can sign in with a PIN.
          </p>

          <form
            className="mt-6 space-y-4"
            onSubmit={async (e) => {
              e.preventDefault();
              setBusy(true);
              try {
                await run({ data: { ...f, hourlyRate: Number(f.hourlyRate) } });
                toast.success("Owner created. You can sign in now.");
                navigate({ to: "/" });
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
            <div>
              <Label>Hourly rate</Label>
              <Input
                type="number"
                min="0"
                step="1"
                value={f.hourlyRate}
                onChange={(e) => setF({ ...f, hourlyRate: e.target.value })}
              />
            </div>
            <Button className="w-full" disabled={busy || !f.fullName || !f.staffCode || f.pin.length < 4}>
              {busy && <Loader2 className="animate-spin" />}
              Create account
            </Button>
          </form>

          <button
            type="button"
            className="mt-5 text-sm text-muted-foreground hover:text-foreground"
            onClick={() => navigate({ to: "/" })}
          >
            Already have an account? Sign in
          </button>
        </section>
      </div>
    </div>
  );
}
