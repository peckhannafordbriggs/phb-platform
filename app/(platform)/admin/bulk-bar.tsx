"use client";

import { useState } from "react";

/**
 * The bulk action bar: confirm first, then report what actually happened.
 *
 * Two things PHASE-10 asks for that the previous version did not do. It ran the
 * action on click with no confirmation, and reported only a count — so an admin
 * who selected forty people and saw "done" could not tell whether all forty
 * changed, or three changed and thirty-seven already had the grant, or two were
 * refused by a guardrail.
 *
 * Scope is fixed at grants and status. There is deliberately no general
 * "apply something to the selection" shape here: CLAUDE.md prohibits any bulk
 * path that could send, and the narrowest possible surface is how that stays
 * true rather than being remembered.
 */

export interface BulkOutcome {
  employeeId: string;
  label: string;
  result: "changed" | "unchanged" | "failed";
  reason?: string;
}

export interface BulkSummary {
  changed: number;
  unchanged: number;
  failed: number;
  outcomes: BulkOutcome[];
}

type Pending =
  | { kind: "grant"; moduleKey: string; moduleName: string; action: "grant" | "revoke" }
  | { kind: "status"; status: "active" | "disabled" };

export function BulkBar({
  selectedIds,
  modules,
  onClear,
  onDone,
}: {
  selectedIds: string[];
  modules: { key: string; displayName: string }[];
  onClear: () => void;
  onDone: () => void;
}) {
  const [pending, setPending] = useState<Pending | null>(null);
  const [busy, setBusy] = useState(false);
  const [summary, setSummary] = useState<BulkSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  const count = selectedIds.length;

  async function run(): Promise<void> {
    if (pending === null) return;

    setBusy(true);
    setError(null);
    try {
      const [url, body] =
        pending.kind === "grant"
          ? [
              "/api/admin/grants/bulk",
              {
                employeeIds: selectedIds,
                moduleKey: pending.moduleKey,
                action: pending.action,
              },
            ]
          : [
              "/api/admin/status/bulk",
              { employeeIds: selectedIds, status: pending.status },
            ];

      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      const payload = (await response.json().catch(() => null)) as
        | { data?: BulkSummary; error?: { message?: string } }
        | null;

      if (!response.ok || payload?.data === undefined) {
        setError(payload?.error?.message ?? "The action could not be completed.");
        return;
      }

      setSummary(payload.data);
      setPending(null);
      // The list is refreshed even on a partial result: the rows that did change
      // have changed, and leaving stale ones on screen beside a report saying
      // otherwise is its own kind of lie.
      onDone();
    } catch {
      setError("Could not reach the server.");
    } finally {
      setBusy(false);
    }
  }

  if (summary !== null) {
    const failures = summary.outcomes.filter((o) => o.result === "failed");

    return (
      <div className="mb-3 rounded border border-[var(--border)] bg-[var(--surface)] px-4 py-3">
        <p className="text-sm font-medium">
          {summary.changed} changed
          {summary.unchanged > 0 && `, ${summary.unchanged} already as requested`}
          {summary.failed > 0 && `, ${summary.failed} refused`}
        </p>

        {/*
          The part that stops an admin guessing. A guardrail refusal is not a
          system error - it is the platform declining to do something unsafe -
          so it is reported by name and by reason rather than as a failure count.
        */}
        {failures.length > 0 && (
          <ul className="mt-2 space-y-1 text-sm text-red-800">
            {failures.map((o) => (
              <li key={o.employeeId}>
                <span className="font-medium">{o.label}</span>
                {o.reason !== undefined && <> — {o.reason}</>}
              </li>
            ))}
          </ul>
        )}

        <button
          type="button"
          onClick={() => setSummary(null)}
          className="mt-3 rounded border border-[var(--border)] bg-white px-3 py-1 text-xs"
        >
          Dismiss
        </button>
      </div>
    );
  }

  if (pending !== null) {
    const what =
      pending.kind === "grant"
        ? `${pending.action === "grant" ? "Grant" : "Revoke"} ${pending.moduleName}`
        : pending.status === "disabled"
          ? "Disable"
          : "Enable";

    return (
      <div className="mb-3 rounded border border-amber-300 bg-amber-50 px-4 py-3">
        {/*
          PHASE-10: "A confirmation showing how many employees and which module,
          before anything happens." Both numbers are in the sentence, because
          "are you sure?" on its own asks somebody to re-derive what they just
          selected.
        */}
        <p className="text-sm text-amber-900">
          <span className="font-medium">{what}</span> for {count} selected{" "}
          {count === 1 ? "employee" : "employees"}?
          {pending.kind === "status" && pending.status === "disabled" && (
            <>
              {" "}
              Disabling revokes access on their next request. It cannot disable
              you, and it will not leave the platform without an administrator.
            </>
          )}
        </p>

        <div className="mt-3 flex items-center gap-3">
          <button
            type="button"
            disabled={busy}
            onClick={() => void run()}
            className="rounded bg-[var(--accent)] px-3 py-1 text-xs font-medium text-white disabled:opacity-50"
          >
            {busy ? "Working…" : `Yes, ${what.toLowerCase()}`}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => setPending(null)}
            className="rounded border border-[var(--border)] bg-white px-3 py-1 text-xs disabled:opacity-50"
          >
            Cancel
          </button>
        </div>

        {error !== null && (
          <p role="alert" className="mt-2 text-sm text-red-700">
            {error}
          </p>
        )}
      </div>
    );
  }

  if (count === 0) return null;

  return (
    <div className="mb-3 flex flex-wrap items-center gap-3 rounded border border-[var(--border)] bg-[var(--surface)] px-4 py-3">
      <span className="text-sm font-medium">{count} selected</span>

      {modules.map((m) => (
        <span key={m.key} className="flex items-center gap-2">
          <BulkButton
            onClick={() =>
              setPending({
                kind: "grant",
                moduleKey: m.key,
                moduleName: m.displayName,
                action: "grant",
              })
            }
          >
            Grant {m.displayName}
          </BulkButton>
          <BulkButton
            onClick={() =>
              setPending({
                kind: "grant",
                moduleKey: m.key,
                moduleName: m.displayName,
                action: "revoke",
              })
            }
          >
            Revoke {m.displayName}
          </BulkButton>
        </span>
      ))}

      <span className="flex items-center gap-2 border-l border-[var(--border)] pl-3">
        <BulkButton onClick={() => setPending({ kind: "status", status: "active" })}>
          Enable
        </BulkButton>
        <BulkButton onClick={() => setPending({ kind: "status", status: "disabled" })}>
          Disable
        </BulkButton>
      </span>

      <button
        type="button"
        onClick={onClear}
        className="text-xs text-[var(--muted)] underline underline-offset-2"
      >
        Clear
      </button>
    </div>
  );
}

function BulkButton({
  onClick,
  children,
}: {
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded border border-[var(--border)] bg-white px-3 py-1 text-xs hover:bg-[var(--surface)]"
    >
      {children}
    </button>
  );
}
