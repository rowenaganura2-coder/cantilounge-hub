import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useMemo, useRef, useState } from "react";
import { Download, Search, Upload } from "lucide-react";
import { z } from "zod";
import { toast } from "sonner";
import { mysql } from "@/integrations/mysql/client";
import { createDatabaseBackup, restoreDatabaseBackup } from "@/lib/backup.functions";
import { hasAny } from "@/lib/staff-auth";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

export const Route = createFileRoute("/_authenticated/audit-logs")({
  head: () => ({
    meta: [
      { title: "Audit Trail — CantiLounge Hub" },
      { name: "description", content: "Immutable owner and admin activity history." },
    ],
  }),
  component: AuditLogsPage,
});

const filters = ["ALL", "ORDER", "MENU_ITEM", "INGREDIENT", "ATTENDANCE"] as const;
type AuditFilter = (typeof filters)[number];
const iterations = 310000;
const backupDataSchema = z.object({
  format: z.literal("cantilounge-hub-backup"),
  version: z.literal(1),
  createdAt: z.string().datetime(),
  tables: z.record(z.string(), z.array(z.record(z.string(), z.unknown()))),
});
const encryptedBackupSchema = z.object({
  format: z.literal("cantilounge-hub-encrypted-backup"),
  version: z.literal(1),
  kdf: z.literal("PBKDF2-SHA-256"),
  iterations: z.literal(iterations),
  salt: z.string(),
  iv: z.string(),
  ciphertext: z.string(),
});

function base64(bytes: Uint8Array) {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

function fromBase64(encoded: string) {
  const binary = atob(encoded);
  const buffer = new ArrayBuffer(binary.length);
  const bytes = new Uint8Array(buffer);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return buffer;
}

async function deriveBackupKey(passphrase: string, salt: ArrayBuffer, usages: KeyUsage[]) {
  const material = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(passphrase),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations, hash: "SHA-256" },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    usages,
  );
}

async function encryptBackup(value: unknown, passphrase: string) {
  const saltBuffer = new ArrayBuffer(16);
  const salt = new Uint8Array(saltBuffer);
  const ivBuffer = new ArrayBuffer(12);
  const iv = new Uint8Array(ivBuffer);
  crypto.getRandomValues(salt);
  crypto.getRandomValues(iv);
  const key = await deriveBackupKey(passphrase, saltBuffer, ["encrypt"]);
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: ivBuffer },
    key,
    new TextEncoder().encode(JSON.stringify(value)),
  );
  return JSON.stringify({
    format: "cantilounge-hub-encrypted-backup",
    version: 1,
    kdf: "PBKDF2-SHA-256",
    iterations,
    salt: base64(salt),
    iv: base64(iv),
    ciphertext: base64(new Uint8Array(ciphertext)),
  });
}

async function decryptBackup(envelope: z.infer<typeof encryptedBackupSchema>, passphrase: string) {
  const key = await deriveBackupKey(passphrase, fromBase64(envelope.salt), ["decrypt"]);
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: fromBase64(envelope.iv) },
    key,
    fromBase64(envelope.ciphertext),
  );
  return JSON.parse(new TextDecoder().decode(plaintext));
}

function AuditLogsPage() {
  const { staff } = Route.useRouteContext();
  const isAdmin = hasAny(staff.roles, ["ADMIN"]);
  const qc = useQueryClient();
  const createBackup = useServerFn(createDatabaseBackup);
  const restoreBackup = useServerFn(restoreDatabaseBackup);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<AuditFilter>("ALL");
  const [backupBusy, setBackupBusy] = useState(false);
  const restoreInput = useRef<HTMLInputElement>(null);
  const {
    data: logs,
    error,
    isPending,
  } = useQuery({
    queryKey: ["audit-logs"],
    enabled: isAdmin,
    queryFn: async () => {
      const { data, error: logsError } = await mysql
        .from("audit_logs")
        .select(
          "id, actor_user_id, actor_role, action_type, entity_type, entity_id, entity_label, old_value, new_value, created_at",
        )
        .order("created_at", { ascending: false })
        .limit(500);
      if (logsError) throw logsError;
      const actorIds = [
        ...new Set(data.flatMap((entry) => (entry.actor_user_id ? [entry.actor_user_id] : []))),
      ];
      const { data: actors, error: actorsError } = actorIds.length
        ? await mysql.from("staff_profiles").select("id, full_name").in("id", actorIds)
        : { data: [], error: null };
      if (actorsError) throw actorsError;
      const names = new Map((actors ?? []).map((actor) => [actor.id, actor.full_name]));
      return data.map((entry) => ({
        ...entry,
        actorName: entry.actor_user_id
          ? (names.get(entry.actor_user_id) ?? "Former staff")
          : "System",
      }));
    },
  });
  const visibleLogs = useMemo(() => {
    const query = search.trim().toLowerCase();
    return (logs ?? []).filter((entry) => {
      const matchesFilter = filter === "ALL" || entry.entity_type === filter;
      const haystack = [
        entry.actorName,
        entry.action_type,
        entry.entity_type,
        entry.entity_label,
        entry.entity_id,
        JSON.stringify(entry.old_value),
        JSON.stringify(entry.new_value),
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return matchesFilter && (!query || haystack.includes(query));
    });
  }, [filter, logs, search]);

  const downloadBackup = async () => {
    if (
      !window.confirm(
        "Create an encrypted logical backup? It includes staff face templates. Keep the downloaded file and passphrase private.",
      )
    ) {
      return;
    }
    const passphrase = window.prompt("Set a backup passphrase (at least 12 characters).");
    if (!passphrase) return;
    if (passphrase.length < 12) {
      toast.error("Use a passphrase with at least 12 characters.");
      return;
    }
    setBackupBusy(true);
    try {
      const backup = await createBackup();
      const encrypted = await encryptBackup(backup, passphrase);
      const url = URL.createObjectURL(new Blob([encrypted], { type: "application/json" }));
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `cantilounge-backup-${new Date().toISOString().slice(0, 10)}.clbackup`;
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      toast.success("Encrypted database backup downloaded.");
      void qc.invalidateQueries({ queryKey: ["audit-logs"] });
    } catch (error) {
      toast.error(
        `Could not create database backup: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      setBackupBusy(false);
    }
  };

  const restoreFromFile = async (file: File | undefined) => {
    if (!file) return;
    if (restoreInput.current) restoreInput.current.value = "";
    if (
      !window.confirm(
        "Restore this backup as a merge: matching rows will be replaced, missing rows will be restored, and newer rows not in the file will not be deleted. Continue?",
      )
    ) {
      return;
    }
    const passphrase = window.prompt("Enter the backup passphrase.");
    if (!passphrase) return;
    setBackupBusy(true);
    try {
      const envelope = encryptedBackupSchema.parse(JSON.parse(await file.text()));
      const backup = backupDataSchema.parse(await decryptBackup(envelope, passphrase));
      await restoreBackup({ data: { backup } });
      toast.success("Database backup restored. Refreshing records…");
      await qc.invalidateQueries();
    } catch (error) {
      toast.error(
        `Could not restore database backup: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      setBackupBusy(false);
      if (restoreInput.current) restoreInput.current.value = "";
    }
  };

  if (!isAdmin) {
    return (
      <div className="mx-auto max-w-4xl p-6">
        <h1 className="text-3xl">Audit Trail</h1>
        <p className="mt-3 text-sm text-muted-foreground">Owner and Admin access only.</p>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#120B09] p-4 text-[#FAF0E6] sm:p-6 lg:p-8">
      <div className="mx-auto max-w-7xl">
        <header className="mb-6">
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-[#B85D19]">
            Owner / Admin
          </p>
          <h1 className="mt-2 text-4xl">Audit Trail</h1>
          <p className="mt-2 text-sm text-[#C8B6A6]">
            Append-only history of order, menu, stock, and attendance changes.
          </p>
        </header>
        <section className="rounded-2xl border border-[#3A251C] bg-[#1C120E]">
          <div className="flex flex-col gap-3 border-b border-[#3A251C] p-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h2 className="font-display text-xl">Database backup & restore</h2>
              <p className="mt-1 max-w-3xl text-xs leading-relaxed text-[#A98D7D]">
                Encrypted application-data snapshot. Restore merges rows and does not delete newer
                records. Supabase Auth credentials and Storage image files are not included.
              </p>
            </div>
            <div className="flex shrink-0 flex-wrap gap-2">
              <Button
                type="button"
                disabled={backupBusy}
                onClick={() => void downloadBackup()}
                className="bg-[#B85D19] text-white hover:bg-[#A34F15]"
              >
                <Download className="mr-2 size-4" />
                Download backup
              </Button>
              <input
                ref={restoreInput}
                type="file"
                accept=".clbackup,application/json"
                className="hidden"
                aria-label="Select encrypted CantiLounge backup"
                onChange={(event) => void restoreFromFile(event.target.files?.[0])}
              />
              <Button
                type="button"
                variant="outline"
                disabled={backupBusy}
                onClick={() => restoreInput.current?.click()}
                className="border-[#4A3831] text-[#E9B988]"
              >
                <Upload className="mr-2 size-4" />
                {backupBusy ? "Working…" : "Restore backup"}
              </Button>
            </div>
          </div>
          <div className="flex flex-col gap-3 border-b border-[#3A251C] p-4 md:flex-row md:items-center md:justify-between">
            <label className="relative min-w-0 flex-1">
              <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-[#A98D7D]" />
              <Input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search staff, action, target, or details"
                className="border-[#3A251C] bg-[#120B09] pl-9 text-[#FAF0E6]"
              />
            </label>
            <div className="flex flex-wrap gap-2" aria-label="Filter audit events">
              {filters.map((value) => (
                <button
                  key={value}
                  type="button"
                  aria-pressed={filter === value}
                  onClick={() => setFilter(value)}
                  className={`rounded-full border px-3 py-1.5 text-xs font-semibold ${filter === value ? "border-[#B85D19] bg-[#B85D19] text-white" : "border-[#3A251C] text-[#C8B6A6] hover:text-[#FAF0E6]"}`}
                >
                  {value === "MENU_ITEM" ? "MENU" : value}
                </button>
              ))}
            </div>
          </div>
          {error ? (
            <p role="alert" className="p-5 text-sm text-destructive">
              Could not load audit trail: {error.message}
            </p>
          ) : isPending ? (
            <p className="p-5 text-sm text-[#C8B6A6]">Loading audit history…</p>
          ) : visibleLogs.length === 0 ? (
            <p className="p-5 text-sm text-[#C8B6A6]">No matching audit events.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[980px] text-left text-sm">
                <thead className="bg-[#251A15] text-xs uppercase tracking-wide text-[#C8B6A6]">
                  <tr>
                    <th className="p-3">Timestamp</th>
                    <th className="p-3">Staff / role</th>
                    <th className="p-3">Action</th>
                    <th className="p-3">Target</th>
                    <th className="p-3">Old → New</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleLogs.map((entry) => (
                    <tr key={entry.id} className="border-t border-[#3A251C] align-top">
                      <td className="whitespace-nowrap p-3 font-mono text-xs text-[#C8B6A6]">
                        {new Date(entry.created_at).toLocaleString("en-PH", {
                          timeZone: "Asia/Manila",
                        })}
                      </td>
                      <td className="p-3">
                        <div>{entry.actorName}</div>
                        <div className="mt-1 text-[10px] uppercase tracking-wider text-[#A98D7D]">
                          {entry.actor_role}
                        </div>
                      </td>
                      <td className="p-3">
                        <span className="rounded-full border border-[#B85D19]/40 bg-[#B85D19]/10 px-2.5 py-1 text-[10px] font-semibold text-[#E9B988]">
                          {entry.action_type.replaceAll("_", " ")}
                        </span>
                      </td>
                      <td className="p-3">
                        <div>{entry.entity_label ?? entry.entity_type}</div>
                        {entry.entity_id && (
                          <div className="mt-1 font-mono text-[10px] text-[#A98D7D]">
                            {entry.entity_id}
                          </div>
                        )}
                      </td>
                      <td className="max-w-[32rem] p-3 text-xs text-[#C8B6A6]">
                        <details>
                          <summary className="cursor-pointer text-[#E9B988]">View details</summary>
                          <div className="mt-2 grid gap-2 md:grid-cols-2">
                            <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all rounded bg-[#120B09] p-2">
                              {JSON.stringify(entry.old_value, null, 2) ?? "—"}
                            </pre>
                            <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all rounded bg-[#120B09] p-2">
                              {JSON.stringify(entry.new_value, null, 2) ?? "—"}
                            </pre>
                          </div>
                        </details>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
