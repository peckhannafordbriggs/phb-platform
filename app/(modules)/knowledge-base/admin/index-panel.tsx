"use client";

import { useCallback, useEffect, useState } from "react";
import type { KbIndexStatus, KbSyncSummary } from "@/lib/modules/knowledge-base/admin";

/**
 * The Knowledge Base index, for module admins: what is indexed, the recent
 * syncs, the files that could not be read, and the Index button.
 *
 * The button only asks: it queues a sync, and the worker job does the work
 * (scripts/kb-worker.ts). While one is queued or running the screen polls
 * every five seconds; the document counts move as files are read, because
 * the sync's own totals are written when it finishes.
 */

const POLL_MS = 5_000;

const STATUS_WORDS: Record<KbSyncSummary["status"], string> = {
  queued: "Waiting for the worker",
  running: "Running",
  ok: "Finished",
  partial: "Finished, some folders unreadable",
  failed: "Failed",
};

function when(iso: string | null): string {
  if (!iso) return "";
  return new Date(iso).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: "America/New_York",
  });
}

function ago(iso: string | null, now: number): string {
  if (!iso) return "";
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 60) return `${s} s ago`;
  const m = Math.round(s / 60);
  return m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`;
}

export function IndexPanel({ initial }: { initial: KbIndexStatus }) {
  const [status, setStatus] = useState(initial);
  const [message, setMessage] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  const latest = status.syncs[0] ?? null;
  const active = latest !== null && (latest.status === "queued" || latest.status === "running");

  const refresh = useCallback(async () => {
    const response = await fetch("/api/modules/knowledge-base/sync", { cache: "no-store" });
    if (response.ok) setStatus(((await response.json()) as { data: KbIndexStatus }).data);
    setNow(Date.now());
  }, []);

  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(timer);
  }, [active, refresh]);

  async function indexNow() {
    setAsking(true);
    setMessage(null);
    try {
      const response = await fetch("/api/modules/knowledge-base/sync", { method: "POST" });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: { message?: string } } | null;
        setMessage(body?.error?.message ?? "The sync could not be queued. Try again.");
      }
      await refresh();
    } finally {
      setAsking(false);
    }
  }

  const { documents, chunks } = status;
  const total = documents.pending + documents.indexed + documents.skipped + documents.failed;

  return (
    <div className="mt-6 space-y-6">
      <section className="card p-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h2 className="font-display text-base font-semibold">Index</h2>
            <p className="mt-1 max-w-xl text-sm text-[var(--muted)]">
              Reads the library, then every new or changed file. Unchanged files are not read again.
            </p>
          </div>
          <button
            type="button"
            onClick={() => void indexNow()}
            disabled={active || asking}
            className="inline-flex h-9 items-center rounded-[var(--radius-control)] bg-[var(--module-accent)] px-4 text-[0.8125rem] font-medium text-white hover:opacity-90 disabled:pointer-events-none disabled:opacity-50"
          >
            {active ? STATUS_WORDS[latest.status] : asking ? "Asking…" : "Index now"}
          </button>
        </div>

        {message && (
          <p role="alert" className="mt-4 text-sm text-[var(--danger)]">
            {message}
          </p>
        )}

        {latest && (
          <p className="mt-4 text-sm" aria-live="polite">
            <span className="font-medium">{STATUS_WORDS[latest.status]}</span>
            {latest.status === "queued" && <> since {when(latest.startedAt)}</>}
            {latest.status === "running" && (
              <> since {when(latest.startedAt)}, last sign of life {ago(latest.heartbeatAt, now)}</>
            )}
            {latest.finishedAt && <> {when(latest.finishedAt)}</>}
            {latest.triggeredBy && <> · asked by {latest.triggeredBy}</>}
          </p>
        )}

        <dl className="mt-5 grid grid-cols-2 gap-4 text-sm sm:grid-cols-5">
          {(
            [
              ["Files", total],
              ["Indexed", documents.indexed],
              ["Waiting", documents.pending],
              ["Skipped", documents.skipped],
              ["Could not read", documents.failed],
            ] as const
          ).map(([label, value]) => (
            <div key={label}>
              <dt className="text-[var(--muted)]">{label}</dt>
              <dd className="mt-0.5 text-lg font-semibold tabular-nums">{value.toLocaleString()}</dd>
            </div>
          ))}
        </dl>
        <p className="mt-3 text-sm text-[var(--muted)]">
          {chunks.total.toLocaleString()} passages, {chunks.embedded.toLocaleString()} embedded.
          {chunks.embedded < chunks.total && " Embedding waits for Azure OpenAI; keyword search works now."}
        </p>
      </section>

      <section className="card p-6">
        <h2 className="font-display text-base font-semibold">Recent syncs</h2>
        {status.syncs.length === 0 ? (
          <p className="mt-2 text-sm text-[var(--muted)]">No sync has run yet.</p>
        ) : (
          <div className="mt-3 max-h-72 overflow-auto">
            <table className="w-full text-left text-sm">
              <thead className="sticky top-0 bg-white text-[var(--muted)]">
                <tr>
                  <th className="py-1.5 pr-4 font-medium">Started</th>
                  <th className="py-1.5 pr-4 font-medium">State</th>
                  <th className="py-1.5 pr-4 font-medium">By</th>
                  <th className="py-1.5 pr-4 text-right font-medium">Files</th>
                  <th className="py-1.5 pr-4 text-right font-medium">Indexed</th>
                  <th className="py-1.5 pr-4 text-right font-medium">Failed</th>
                  <th className="py-1.5 text-right font-medium">Passages</th>
                </tr>
              </thead>
              <tbody>
                {status.syncs.map((s) => (
                  <tr key={s.id} className="border-t border-[var(--border)] align-top">
                    <td className="py-1.5 pr-4 whitespace-nowrap">{when(s.startedAt)}</td>
                    <td className="py-1.5 pr-4">
                      {STATUS_WORDS[s.status]}
                      {s.error && <div className="mt-0.5 text-xs text-[var(--muted)]">{s.error}</div>}
                    </td>
                    <td className="py-1.5 pr-4">{s.triggeredBy ?? (s.trigger === "scheduled" ? "Schedule" : "Platform")}</td>
                    <td className="py-1.5 pr-4 text-right tabular-nums">{s.filesSeen.toLocaleString()}</td>
                    <td className="py-1.5 pr-4 text-right tabular-nums">{s.filesIndexed.toLocaleString()}</td>
                    <td className="py-1.5 pr-4 text-right tabular-nums">{s.filesFailed.toLocaleString()}</td>
                    <td className="py-1.5 text-right tabular-nums">{s.chunksWritten.toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="card p-6">
        <h2 className="font-display text-base font-semibold">
          Files that could not be read ({documents.failed.toLocaleString()})
        </h2>
        {status.failed.length === 0 ? (
          <p className="mt-2 text-sm text-[var(--muted)]">None.</p>
        ) : (
          <>
            <p className="mt-1 text-sm text-[var(--muted)]">
              Every other file was indexed. The next sync tries these again; runbook.md, &ldquo;A Knowledge Base
              file is failed&rdquo;, says what each reason means.
            </p>
            <ul className="mt-3 max-h-72 space-y-2 overflow-auto text-sm">
              {status.failed.map((d) => (
                <li key={d.id}>
                  <div className="font-medium break-all">{d.path}</div>
                  <div className="text-[var(--muted)]">{d.error}</div>
                </li>
              ))}
            </ul>
            {documents.failed > status.failed.length && (
              <p className="mt-2 text-sm text-[var(--muted)]">
                Showing {status.failed.length} of {documents.failed}.
              </p>
            )}
          </>
        )}
      </section>
    </div>
  );
}
