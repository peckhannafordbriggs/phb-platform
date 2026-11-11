"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import type { RunsList, RunSummary } from "@/lib/modules/bas/reports/runs-service";
import { ApiError, type Tone } from "./health-client";
import { fetchRuns } from "./reports-client";
import { TONE_INK, TONE_STYLE } from "./tone";

/**
 * The runs - the Reports bar's first item and the tab's default view since
 * 2026-11-11, the Generated sub-tab before (Reports, Phase 2): every run the viewer may see,
 * newest first, with its period, status, duration and cost. Opening one
 * shows the rendered report. Reloaded every ten seconds while the tab is
 * visible (Phase 3), so a run queued from Scheduled is seen to start and
 * finish; Queued and Running are states a row can hold now. No Resend and
 * no Download PDF: those are Phase 4, and a button that does nothing would
 * be worse than none.
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

  if (data === null) {
    return <p className="p-6 text-sm text-[var(--muted)]">{error?.message ?? "Loading runs…"}</p>;
  }
  return <RunsTable data={data} />;
}

/** Pure, for a node test. */
export function RunsTable({ data }: { data: RunsList }) {
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
              <th className="eyebrow py-2.5 pr-4 text-[var(--muted)]">Delivery</th>
            </tr>
          </thead>
          <tbody>
            {data.runs.map((r) => {
              const tone = runStatusTone(r.status);
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
                    <span
                      className="inline-block rounded-full border px-2 py-0.5 text-[0.6875rem] font-medium"
                      style={{ ...TONE_STYLE[tone], color: TONE_INK[tone] }}
                      title={r.partialReason ?? r.error ?? undefined}
                    >
                      {RUN_STATUS_LABELS[r.status]}
                    </span>
                    {r.partialReason !== null && <div className="mt-1 max-w-[18rem] text-[var(--muted)]">{r.partialReason}</div>}
                    {r.error !== null && <div className="mt-1 max-w-[18rem] text-[var(--muted)]">{r.error}</div>}
                  </td>
                  <td className="py-3 pr-3">{r.buildingStatus ?? "—"}</td>
                  <td className="py-3 pr-3 tabular-nums">{r.findings}</td>
                  <td className="py-3 pr-3">{describeRunDuration(r.durationS)}</td>
                  <td className="py-3 pr-3 tabular-nums">
                    {money(r.costUsd)} <span className="text-[var(--muted)]">of ${r.budgetUsd.toFixed(2)}</span>
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
