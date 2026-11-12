"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui";
import { describePdfState, pdfStateKind } from "@/lib/modules/bas/reports/pdf/naming";
import type { RunsList, RunSummary } from "@/lib/modules/bas/reports/runs-service";
import { ApiError, type Tone } from "./health-client";
import { downloadRunPdf, fetchRuns, retryRunPdf } from "./reports-client";
import { DownloadPdfButton } from "./reports-run-actions";
import { TONE_INK, TONE_STYLE } from "./tone";

/**
 * The runs - the Reports bar's first item and the tab's default view since
 * 2026-11-11, the Generated sub-tab before (Reports, Phase 2): every run the viewer may see,
 * newest first, with its period, status, duration and cost. Opening one
 * shows the rendered report. Reloaded every ten seconds while the tab is
 * visible (Phase 3), so a run queued from Scheduled is seen to start and
 * finish; Queued and Running are states a row can hold now. Since Phase 4's
 * PDF half (2026-11-13) each row carries its PDF's state and a Download -
 * greyed with a tooltip until the PDF is ready - and Retry PDF when a
 * render failed. No Resend: email is the other half of Phase 4, and a
 * button that does nothing would be worse than none.
 */

/** How often the list reloads while the tab is visible. */
export const RUNS_POLL_MS = 10_000;

export const RUN_STATUS_LABELS: Record<RunSummary["status"], string> = {
  queued: "Queued",
  running: "Running",
  succeeded: "Succeeded",
  partial: "Partial",
  failed: "Failed",
};

export function runStatusTone(status: RunSummary["status"]): Tone {
  switch (status) {
    case "succeeded":
      return "ok";
    case "partial":
      return "warn";
    case "failed":
      return "bad";
    case "queued":
    case "running":
      return "neutral";
  }
}

const money = (n: number) => `$${n.toFixed(4)}`;

/** A run's status as the module's chip: the tone is the state, the words beside it. Shared with the Usage page. */
export function RunStatusChip({ status, title }: { status: RunSummary["status"]; title?: string }) {
  const tone = runStatusTone(status);
  return (
    <span
      className="inline-block rounded-full border px-2 py-0.5 text-[0.6875rem] font-medium"
      style={{ ...TONE_STYLE[tone], color: TONE_INK[tone] }}
      title={title}
    >
      {RUN_STATUS_LABELS[status]}
    </span>
  );
}

export function describePeriod(run: Pick<RunSummary, "periodStart" | "periodEnd" | "timezone">): string {
  const f = new Intl.DateTimeFormat("en-GB", { timeZone: run.timezone, day: "numeric", month: "short" });
  return `${f.format(new Date(run.periodStart))} – ${f.format(new Date(run.periodEnd))}`;
}

export function describeRunDuration(s: number | null): string {
  if (s === null) return "—";
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60} s`;
}

export function GeneratedView() {
  const [data, setData] = useState<RunsList | null>(null);
  const [error, setError] = useState<ApiError | null>(null);

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      setData(await fetchRuns(null, signal));
      setError(null);
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === "AbortError") return;
      setError(cause instanceof ApiError ? cause : new ApiError("unexpected", "Something went wrong."));
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  useEffect(() => {
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, RUNS_POLL_MS);
    return () => clearInterval(timer);
  }, [load]);

  const [busyRunId, setBusyRunId] = useState<string | null>(null);
  const retryPdf = useCallback(
    async (runId: string) => {
      setBusyRunId(runId);
      try {
        await retryRunPdf(runId);
        await load();
      } catch (cause) {
        setError(cause instanceof ApiError ? cause : new ApiError("unexpected", "Something went wrong."));
      } finally {
        setBusyRunId(null);
      }
    },
    [load],
  );

  if (data === null) {
    return <p className="p-6 text-sm text-[var(--muted)]">{error?.message ?? "Loading runs…"}</p>;
  }
  return (
    <>
      {error !== null && (
        <p className="mb-3 rounded-[var(--radius-row)] border p-3 text-sm" style={TONE_STYLE.bad} role="alert">
          {error.message}
        </p>
      )}
      <RunsTable data={data} onRetryPdf={(runId) => void retryPdf(runId)} busyRunId={busyRunId} />
    </>
  );
}

/** Pure, for a node test; Retry PDF is the one action a row takes here. */
export function RunsTable({
  data,
  onRetryPdf,
  busyRunId = null,
}: {
  data: RunsList;
  onRetryPdf?: (runId: string) => void;
  busyRunId?: string | null;
}) {
  if (data.runs.length === 0 && data.runsInDatabase === 0) {
    return (
      <section className="card p-8 text-center">
        <p className="text-sm font-medium">No reports have been generated yet</p>
        <p className="mt-1 text-sm text-[var(--muted)]">
          A run appears here when one is made. Until the scheduler and worker exist, a run is started from the
          command line with the dev script; the runbook has the command.
        </p>
      </section>
    );
  }
  return (
    <section className="card p-0">
      {data.runs.length !== data.runsInDatabase && (
        <p className="m-4 rounded-[var(--radius-row)] border p-3 text-sm" style={TONE_STYLE.bad} role="alert">
          This list shows {data.runs.length} of the {data.runsInDatabase} runs you may see.
        </p>
      )}
      <div className="max-h-[36rem] overflow-auto">
        <table className="w-full text-[0.8125rem]">
          <thead className="sticky top-0 z-10 bg-[var(--surface)] text-left text-[var(--muted)]">
            <tr>
              <th className="eyebrow px-4 py-2.5 text-[var(--muted)]">Report</th>
              <th className="eyebrow py-2.5 pr-3 text-[var(--muted)]">Period</th>
              <th className="eyebrow py-2.5 pr-3 text-[var(--muted)]">Status</th>
              <th className="eyebrow py-2.5 pr-3 text-[var(--muted)]">Building status</th>
              <th className="eyebrow py-2.5 pr-3 text-[var(--muted)]">Findings</th>
              <th className="eyebrow py-2.5 pr-3 text-[var(--muted)]">Duration</th>
              <th className="eyebrow py-2.5 pr-3 text-[var(--muted)]">Cost</th>
              <th className="eyebrow py-2.5 pr-3 text-[var(--muted)]">PDF</th>
              <th className="eyebrow py-2.5 pr-4 text-[var(--muted)]">Delivery</th>
            </tr>
          </thead>
          <tbody>
            {data.runs.map((r) => {
              return (
                <tr key={r.runId} className="border-t border-[var(--divider-soft)] align-top">
                  <td className="px-4 py-3">
                    <Link href={`/bas/reports/generated/${encodeURIComponent(r.runId)}`} className="font-medium hover:underline">
                      {r.reportName}
                    </Link>
                    <div className="text-[var(--muted)]">
                      {r.buildingName} · {r.trigger}
                      {r.startedBy !== null ? ` · ${r.startedBy}` : ""}
                    </div>
                  </td>
                  <td className="py-3 pr-3">{describePeriod(r)}</td>
                  <td className="py-3 pr-3">
                    <RunStatusChip status={r.status} title={r.partialReason ?? r.error ?? undefined} />
                    {r.partialReason !== null && <div className="mt-1 max-w-[18rem] text-[var(--muted)]">{r.partialReason}</div>}
                    {r.error !== null && <div className="mt-1 max-w-[18rem] text-[var(--muted)]">{r.error}</div>}
                  </td>
                  <td className="py-3 pr-3">{r.buildingStatus ?? "—"}</td>
                  <td className="py-3 pr-3 tabular-nums">{r.findings}</td>
                  <td className="py-3 pr-3">{describeRunDuration(r.durationS)}</td>
                  <td className="py-3 pr-3 tabular-nums">
                    {money(r.costUsd)} <span className="text-[var(--muted)]">of ${r.budgetUsd.toFixed(2)}</span>
                  </td>
                  <td className="py-3 pr-3">
                    <PdfCell run={r} onRetryPdf={onRetryPdf} busy={busyRunId === r.runId} />
                  </td>
                  <td className="py-3 pr-4 text-[var(--muted)]">Not sent: email is a later phase</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/**
 * The PDF's state in words, then Download - greyed with its reason until the
 * PDF is ready - and Retry PDF when a render failed. The error is the
 * tooltip on both the words and the button.
 */
export function PdfCell({ run, onRetryPdf, busy }: { run: RunSummary; onRetryPdf?: (runId: string) => void; busy: boolean }) {
  const kind = pdfStateKind(run.pdf);
  return (
    <div className="flex flex-col gap-1">
      <span
        className={kind === "failed" ? "text-[var(--danger)]" : "text-[var(--muted)]"}
        title={run.pdf.error ?? undefined}
        data-testid="run-pdf-state"
      >
        {describePdfState(run.pdf)}
      </span>
      <div className="flex flex-wrap gap-1">
        <DownloadPdfButton pdf={run.pdf} size="sm" onClick={() => downloadRunPdf(run.runId)} />
        {kind === "failed" && onRetryPdf !== undefined && (
          <Button size="sm" disabled={busy} onClick={() => onRetryPdf(run.runId)} title={run.pdf.error ?? undefined} testId="run-retry-pdf">
            Retry PDF
          </Button>
        )}
      </div>
    </div>
  );
}
