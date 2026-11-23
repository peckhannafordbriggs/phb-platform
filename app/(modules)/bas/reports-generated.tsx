"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui";
import { DELETE_CONFIRM_SENTENCE, SCHEDULE_DELETED_LABEL, deleteConfirmHeading } from "@/lib/modules/bas/reports/deletion-words";
import { describePdfState, pdfStateKind } from "@/lib/modules/bas/reports/pdf/naming";
import type { RunsList, RunSummary } from "@/lib/modules/bas/reports/runs-service";
import { ApiError, type Tone } from "./health-client";
import { ConfirmDialog } from "./reports-confirm";
import { deleteRuns, downloadRunPdf, fetchRuns, resendRunEmail, restoreRuns, retryRunPdf } from "./reports-client";
import { DeliveryCell } from "./reports-run-deliveries";
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
 * render failed. Since the email half (2026-11-17) the Delivery column is
 * the run's email - "3 of 3 sent", "1 failed" with Resend beside it, "Not
 * sent — sending disabled" while the worker's send gate is closed
 * (reports-run-deliveries.tsx).
 *
 * DELETE (2026-11-20). A box per finished row, a box in the header for every
 * finished row shown, and Delete on each row; one confirmation naming the
 * count, then the runs go to Recently deleted (the button above the table),
 * where they can be restored for 15 days. The notice after a delete offers
 * Undo, which is a restore of exactly those runs. A queued or running row
 * has no box and no Delete: it is the worker's until it finishes. The
 * selection survives the ten-second reload; a run that leaves the list
 * leaves the selection.
 *
 * A run whose REPORT was deleted (2026-11-20) stays here as it was, its
 * name followed by "(schedule deleted)": no more runs of it will come, and
 * it goes only by its own Delete.
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

/** Whether a run can be deleted: only once it has finished. */
export function isDeletable(run: Pick<RunSummary, "status">): boolean {
  return run.status === "succeeded" || run.status === "partial" || run.status === "failed";
}

const NOT_DELETABLE_TITLE = "A queued or running run can be deleted once it has finished.";

const runsWord = (n: number) => (n === 1 ? "1 run" : `${n} runs`);

/** What the notice above the list says after a delete or an undo. */
type Notice = { kind: "deleted"; runIds: string[] } | { kind: "restored"; count: number };

export function GeneratedView() {
  const [data, setData] = useState<RunsList | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [confirming, setConfirming] = useState<string[] | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [deleting, setDeleting] = useState(false);

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const next = await fetchRuns(null, signal);
      setData(next);
      // A run that left the list, or is no longer deletable, leaves the selection.
      const keep = new Set(next.runs.filter(isDeletable).map((r) => r.runId));
      setSelected((prev) => {
        const pruned = [...prev].filter((id) => keep.has(id));
        return pruned.length === prev.size ? prev : new Set(pruned);
      });
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
  const resend = useCallback(
    async (runId: string) => {
      setBusyRunId(runId);
      try {
        await resendRunEmail(runId);
        await load();
      } catch (cause) {
        setError(cause instanceof ApiError ? cause : new ApiError("unexpected", "Something went wrong."));
      } finally {
        setBusyRunId(null);
      }
    },
    [load],
  );
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

  const confirmDelete = useCallback(async () => {
    if (confirming === null) return;
    const runIds = confirming;
    setDeleting(true);
    try {
      await deleteRuns(runIds);
      setConfirming(null);
      setSelected((prev) => new Set([...prev].filter((id) => !runIds.includes(id))));
      setNotice({ kind: "deleted", runIds });
      setError(null);
      await load();
    } catch (cause) {
      setConfirming(null);
      setError(cause instanceof ApiError ? cause : new ApiError("unexpected", "Something went wrong."));
      await load();
    } finally {
      setDeleting(false);
    }
  }, [confirming, load]);

  const undo = useCallback(
    async (runIds: string[]) => {
      setDeleting(true);
      try {
        const { restored } = await restoreRuns(runIds);
        setNotice({ kind: "restored", count: restored });
        setError(null);
        await load();
      } catch (cause) {
        setError(cause instanceof ApiError ? cause : new ApiError("unexpected", "Something went wrong."));
      } finally {
        setDeleting(false);
      }
    },
    [load],
  );

  const toggle = useCallback((runId: string, on: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (on) next.add(runId);
      else next.delete(runId);
      return next;
    });
  }, []);
  const toggleAll = useCallback(
    (on: boolean) => setSelected(on && data !== null ? new Set(data.runs.filter(isDeletable).map((r) => r.runId)) : new Set()),
    [data],
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
      {notice !== null && (
        <div
          className="mb-3 flex flex-wrap items-center gap-3 rounded-[var(--radius-row)] border p-3 text-sm"
          style={TONE_STYLE.ok}
          role="status"
          data-testid="runs-notice"
        >
          <span>
            {notice.kind === "deleted"
              ? `${runsWord(notice.runIds.length)} moved to Recently deleted.`
              : `${runsWord(notice.count)} restored to the list.`}
          </span>
          {notice.kind === "deleted" && (
            <Button size="sm" disabled={deleting} onClick={() => void undo(notice.runIds)} testId="runs-undo-delete">
              Undo
            </Button>
          )}
          <button type="button" className="ml-auto text-xs underline" onClick={() => setNotice(null)}>
            Dismiss
          </button>
        </div>
      )}
      <RunsToolbar
        selectedCount={selected.size}
        busy={deleting}
        onDeleteSelected={() => setConfirming([...selected])}
        onClearSelection={() => setSelected(new Set())}
      />
      <RunsTable
        data={data}
        onRetryPdf={(runId) => void retryPdf(runId)}
        onResend={(runId) => void resend(runId)}
        busyRunId={busyRunId}
        selection={{ selected, onToggle: toggle, onToggleAll: toggleAll }}
        onDelete={(runId) => setConfirming([runId])}
      />
      {confirming !== null && (
        <DeleteRunsDialog count={confirming.length} busy={deleting} onCancel={() => setConfirming(null)} onConfirm={() => void confirmDelete()} />
      )}
    </>
  );
}

/**
 * Above the table: the selection's count and its Delete on the left once
 * anything is ticked, and Recently deleted on the right, always.
 */
export function RunsToolbar({
  selectedCount,
  busy = false,
  onDeleteSelected,
  onClearSelection,
}: {
  selectedCount: number;
  busy?: boolean;
  onDeleteSelected?: () => void;
  onClearSelection?: () => void;
}) {
  return (
    <div className="mb-3 flex min-h-7 flex-wrap items-center gap-2" data-testid="runs-toolbar">
      {selectedCount > 0 && (
        <>
          <span className="text-sm font-medium" data-testid="runs-selected-count">
            {selectedCount} selected
          </span>
          <Button size="sm" variant="danger" disabled={busy} onClick={onDeleteSelected} testId="runs-delete-selected">
            Delete {runsWord(selectedCount)}
          </Button>
          <Button size="sm" disabled={busy} onClick={onClearSelection}>
            Clear
          </Button>
        </>
      )}
      <Button size="sm" href="/bas/reports/deleted" className="ml-auto" testId="runs-recently-deleted">
        Recently deleted
      </Button>
    </div>
  );
}

/** The confirmation for runs: how many, where they go, and for how long they can come back. */
export function DeleteRunsDialog({
  count,
  busy = false,
  onCancel,
  onConfirm,
}: {
  count: number;
  busy?: boolean;
  onCancel?: () => void;
  onConfirm?: () => void;
}) {
  return (
    <ConfirmDialog
      heading={deleteConfirmHeading(count)}
      sentence={DELETE_CONFIRM_SENTENCE}
      confirmLabel={`Delete ${runsWord(count)}`}
      busyLabel="Deleting…"
      busy={busy}
      testIdPrefix="runs-delete"
      onCancel={onCancel}
      onConfirm={onConfirm}
    />
  );
}

/** A run's report name, and "(schedule deleted)" beside it when the report itself is gone (2026-11-20). */
export function RunReportName({ run }: { run: Pick<RunSummary, "reportName" | "reportDeleted"> }) {
  return (
    <>
      {run.reportName}
      {run.reportDeleted && (
        <span className="ml-1 font-normal text-[var(--muted)]" data-testid="run-schedule-deleted">
          {SCHEDULE_DELETED_LABEL}
        </span>
      )}
    </>
  );
}

export interface RunsSelection {
  selected: ReadonlySet<string>;
  onToggle: (runId: string, on: boolean) => void;
  onToggleAll: (on: boolean) => void;
}

/**
 * Pure, for a node test; Retry PDF and Resend are two actions a row takes
 * here, and Delete (2026-11-20) the third. The box column and the Delete
 * column are drawn only when their handlers are passed.
 */
export function RunsTable({
  data,
  onRetryPdf,
  onResend,
  busyRunId = null,
  selection,
  onDelete,
}: {
  data: RunsList;
  onRetryPdf?: (runId: string) => void;
  onResend?: (runId: string) => void;
  busyRunId?: string | null;
  selection?: RunsSelection;
  onDelete?: (runId: string) => void;
}) {
  const deletable = useMemo(() => data.runs.filter(isDeletable), [data.runs]);
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
  const allTicked = selection !== undefined && deletable.length > 0 && deletable.every((r) => selection.selected.has(r.runId));
  const someTicked = selection !== undefined && deletable.some((r) => selection.selected.has(r.runId));
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
              {selection !== undefined && (
                <th className="w-10 py-2.5 pl-4">
                  <SelectAllBox
                    checked={allTicked}
                    indeterminate={someTicked && !allTicked}
                    disabled={deletable.length === 0}
                    onChange={(on) => selection.onToggleAll(on)}
                  />
                </th>
              )}
              <th className={`eyebrow ${selection !== undefined ? "pr-4 pl-2" : "px-4"} py-2.5 text-[var(--muted)]`}>Report</th>
              <th className="eyebrow py-2.5 pr-3 text-[var(--muted)]">Period</th>
              <th className="eyebrow py-2.5 pr-3 text-[var(--muted)]">Status</th>
              <th className="eyebrow py-2.5 pr-3 text-[var(--muted)]">Building status</th>
              <th className="eyebrow py-2.5 pr-3 text-[var(--muted)]">Findings</th>
              <th className="eyebrow py-2.5 pr-3 text-[var(--muted)]">Duration</th>
              <th className="eyebrow py-2.5 pr-3 text-[var(--muted)]">Cost</th>
              <th className="eyebrow py-2.5 pr-3 text-[var(--muted)]">PDF</th>
              <th className="eyebrow py-2.5 pr-4 text-[var(--muted)]">Delivery</th>
              {onDelete !== undefined && (
                <th className="eyebrow py-2.5 pr-4 text-[var(--muted)]">
                  <span className="sr-only">Delete</span>
                </th>
              )}
            </tr>
          </thead>
          <tbody>
            {data.runs.map((r) => {
              const canDelete = isDeletable(r);
              const ticked = selection?.selected.has(r.runId) ?? false;
              return (
                <tr
                  key={r.runId}
                  className="border-t border-[var(--divider-soft)] align-top"
                  style={ticked ? { background: "var(--neutral-50)" } : undefined}
                  data-testid="run-row"
                >
                  {selection !== undefined && (
                    <td className="py-3 pl-4">
                      <input
                        type="checkbox"
                        className="mt-0.5"
                        checked={ticked}
                        disabled={!canDelete}
                        title={canDelete ? undefined : NOT_DELETABLE_TITLE}
                        aria-label={`Select the run of ${r.reportName}, ${describePeriod(r)}`}
                        onChange={(e) => selection.onToggle(r.runId, e.target.checked)}
                        data-testid="run-select"
                      />
                    </td>
                  )}
                  <td className={`${selection !== undefined ? "pr-4 pl-2" : "px-4"} py-3`}>
                    <Link href={`/bas/reports/generated/${encodeURIComponent(r.runId)}`} className="font-medium hover:underline">
                      <RunReportName run={r} />
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
                  <td className="py-3 pr-4">
                    <DeliveryCell run={r} onResend={onResend} busy={busyRunId === r.runId} />
                  </td>
                  {onDelete !== undefined && (
                    <td className="py-3 pr-4">
                      <Button
                        size="sm"
                        variant="danger"
                        disabled={!canDelete}
                        title={canDelete ? undefined : NOT_DELETABLE_TITLE}
                        ariaLabel={`Delete the run of ${r.reportName}, ${describePeriod(r)}`}
                        onClick={() => onDelete(r.runId)}
                        testId="run-delete"
                      >
                        Delete
                      </Button>
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/** The header's box: ticks every finished row shown, and reads half-ticked when some are. */
export function SelectAllBox({
  checked,
  indeterminate,
  disabled,
  onChange,
  label = "Select every finished run shown",
}: {
  checked: boolean;
  indeterminate: boolean;
  disabled: boolean;
  onChange: (on: boolean) => void;
  label?: string;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current !== null) ref.current.indeterminate = indeterminate;
  }, [indeterminate]);
  return (
    <input
      ref={ref}
      type="checkbox"
      checked={checked}
      disabled={disabled}
      aria-label={label}
      onChange={(e) => onChange(e.target.checked)}
      data-testid="run-select-all"
    />
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
