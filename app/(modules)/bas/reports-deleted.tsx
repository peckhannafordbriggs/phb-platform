"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui";
import { RECYCLE_DAYS, describeDaysRemaining, describeDeletedBy } from "@/lib/modules/bas/reports/deletion-words";
import type { DeletedRunSummary, DeletedRunsList } from "@/lib/modules/bas/reports/runs-service";
import { ApiError } from "./health-client";
import { fetchDeletedRuns, restoreRuns } from "./reports-client";
import { RunReportName, RunStatusChip, SelectAllBox, describePeriod } from "./reports-generated";
import { TONE_INK, TONE_STYLE } from "./tone";

/**
 * Recently deleted (2026-11-20), at /bas/reports/deleted, opened from the
 * button above the runs: the viewer's deleted runs - their own reports', or
 * every report's for a module admin - newest deletion first, each with when
 * it was deleted and by whom (a person, or the report's retention), and the
 * days left before the scheduler removes it for good. Restore on a row, or
 * on a selection; a restored run is back on the list whole, and retention
 * never takes it again.
 *
 * Days left are whole days rounded up: 15 on the day of the delete, 1 in the
 * last day, then "Purged at the next pass" - the scheduler runs every
 * fifteen minutes.
 */

const DELETED_AT = new Intl.DateTimeFormat("en-GB", {
  timeZone: "America/New_York",
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

const runsWord = (n: number) => (n === 1 ? "1 run" : `${n} runs`);

export function RecentlyDeletedView() {
  const [data, setData] = useState<DeletedRunsList | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [restored, setRestored] = useState<number | null>(null);

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const next = await fetchDeletedRuns(signal);
      setData(next);
      const keep = new Set(next.runs.map((r) => r.runId));
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

  const restore = useCallback(
    async (runIds: string[]) => {
      setBusy(true);
      try {
        const result = await restoreRuns(runIds);
        setRestored(result.restored);
        setSelected((prev) => new Set([...prev].filter((id) => !runIds.includes(id))));
        setError(null);
      } catch (cause) {
        setError(cause instanceof ApiError ? cause : new ApiError("unexpected", "Something went wrong."));
      } finally {
        await load();
        setBusy(false);
      }
    },
    [load],
  );

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Link href="/bas/reports" className="text-sm text-[var(--muted)] hover:underline">
          ← Reports
        </Link>
        {selected.size > 0 && (
          <>
            <span className="ml-auto text-sm font-medium" data-testid="deleted-selected-count">
              {selected.size} selected
            </span>
            <Button size="sm" variant="primary" disabled={busy} onClick={() => void restore([...selected])} testId="deleted-restore-selected">
              Restore {runsWord(selected.size)}
            </Button>
            <Button size="sm" disabled={busy} onClick={() => setSelected(new Set())}>
              Clear
            </Button>
          </>
        )}
      </div>
      {error !== null && (
        <p className="rounded-[var(--radius-row)] border p-3 text-sm" style={TONE_STYLE.bad} role="alert">
          {error.message}
        </p>
      )}
      {restored !== null && (
        <p className="rounded-[var(--radius-row)] border p-3 text-sm" style={TONE_STYLE.ok} role="status" data-testid="deleted-notice">
          {runsWord(restored)} restored to the Reports list.
        </p>
      )}
      {data === null ? (
        <p className="p-6 text-sm text-[var(--muted)]">{error === null ? "Loading…" : ""}</p>
      ) : (
        <DeletedRunsTable
          data={data}
          busy={busy}
          selected={selected}
          onToggle={(runId, on) =>
            setSelected((prev) => {
              const next = new Set(prev);
              if (on) next.add(runId);
              else next.delete(runId);
              return next;
            })
          }
          onToggleAll={(on) => setSelected(on ? new Set(data.runs.map((r) => r.runId)) : new Set())}
          onRestore={(runId) => void restore([runId])}
        />
      )}
    </div>
  );
}

/** Pure, for a node test. */
export function DeletedRunsTable({
  data,
  busy = false,
  selected = new Set(),
  onToggle,
  onToggleAll,
  onRestore,
}: {
  data: DeletedRunsList;
  busy?: boolean;
  selected?: ReadonlySet<string>;
  onToggle?: (runId: string, on: boolean) => void;
  onToggleAll?: (on: boolean) => void;
  onRestore?: (runId: string) => void;
}) {
  if (data.runs.length === 0 && data.runsInDatabase === 0) {
    return (
      <section className="card p-8 text-center" data-testid="deleted-empty">
        <p className="text-sm font-medium">Nothing in Recently deleted</p>
        <p className="mt-1 text-sm text-[var(--muted)]">A deleted run stays here for {RECYCLE_DAYS} days, then it is removed for good.</p>
      </section>
    );
  }
  const allTicked = data.runs.length > 0 && data.runs.every((r) => selected.has(r.runId));
  const someTicked = data.runs.some((r) => selected.has(r.runId));
  return (
    <section className="card p-0">
      <p className="border-b border-[var(--divider-soft)] px-4 py-3 text-sm text-[var(--muted)]">
        A deleted run stays here for {RECYCLE_DAYS} days with its findings and PDF, then it is removed for good.
      </p>
      {data.runs.length !== data.runsInDatabase && (
        <p className="m-4 rounded-[var(--radius-row)] border p-3 text-sm" style={TONE_STYLE.bad} role="alert">
          This list shows {data.runs.length} of the {data.runsInDatabase} deleted runs you may see.
        </p>
      )}
      <div className="max-h-[36rem] overflow-auto">
        <table className="w-full text-[0.8125rem]">
          <thead className="sticky top-0 z-10 bg-[var(--surface)] text-left text-[var(--muted)]">
            <tr>
              {onToggle !== undefined && (
                <th className="w-10 py-2.5 pl-4">
                  <SelectAllBox
                    checked={allTicked}
                    indeterminate={someTicked && !allTicked}
                    disabled={data.runs.length === 0}
                    onChange={(on) => onToggleAll?.(on)}
                    label="Select every deleted run shown"
                  />
                </th>
              )}
              <th className={`eyebrow ${onToggle !== undefined ? "pr-4 pl-2" : "px-4"} py-2.5 text-[var(--muted)]`}>Report</th>
              <th className="eyebrow py-2.5 pr-3 text-[var(--muted)]">Period</th>
              <th className="eyebrow py-2.5 pr-3 text-[var(--muted)]">Status</th>
              <th className="eyebrow py-2.5 pr-3 text-[var(--muted)]">Deleted</th>
              <th className="eyebrow py-2.5 pr-3 text-[var(--muted)]">Removed in</th>
              <th className="eyebrow py-2.5 pr-4 text-[var(--muted)]">
                <span className="sr-only">Restore</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {data.runs.map((r) => (
              <DeletedRow
                key={r.runId}
                run={r}
                busy={busy}
                ticked={selected.has(r.runId)}
                onToggle={onToggle}
                onRestore={onRestore}
              />
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function DeletedRow({
  run: r,
  busy,
  ticked,
  onToggle,
  onRestore,
}: {
  run: DeletedRunSummary;
  busy: boolean;
  ticked: boolean;
  onToggle?: (runId: string, on: boolean) => void;
  onRestore?: (runId: string) => void;
}) {
  // The last day is amber: tomorrow it is gone.
  const soon = r.daysRemaining <= 1;
  return (
    <tr
      className="border-t border-[var(--divider-soft)] align-top"
      style={ticked ? { background: "var(--neutral-50)" } : undefined}
      data-testid="deleted-row"
    >
      {onToggle !== undefined && (
        <td className="py-3 pl-4">
          <input
            type="checkbox"
            className="mt-0.5"
            checked={ticked}
            aria-label={`Select the deleted run of ${r.reportName}, ${describePeriod(r)}`}
            onChange={(e) => onToggle(r.runId, e.target.checked)}
            data-testid="deleted-select"
          />
        </td>
      )}
      <td className={`${onToggle !== undefined ? "pr-4 pl-2" : "px-4"} py-3`}>
        <span className="font-medium">
          <RunReportName run={r} />
        </span>
        <div className="text-[var(--muted)]">
          {r.buildingName} · {r.trigger}
        </div>
      </td>
      <td className="py-3 pr-3">{describePeriod(r)}</td>
      <td className="py-3 pr-3">
        <RunStatusChip status={r.status} />
      </td>
      <td className="py-3 pr-3">
        {DELETED_AT.format(new Date(r.deletedAt))}
        <div className="text-[var(--muted)]" data-testid="deleted-by">
          by {describeDeletedBy(r.deletedBy, r.deletedByEmail, r.retentionMonths)}
        </div>
      </td>
      <td className="py-3 pr-3" title={`Removed for good after ${DELETED_AT.format(new Date(r.purgeAt))} (New York)`}>
        <span className="tabular-nums" style={soon ? { color: TONE_INK.warn } : undefined} data-testid="deleted-days-left">
          {describeDaysRemaining(r.daysRemaining)}
        </span>
      </td>
      <td className="py-3 pr-4">
        {onRestore !== undefined && (
          <Button
            size="sm"
            disabled={busy}
            ariaLabel={`Restore the run of ${r.reportName}, ${describePeriod(r)}`}
            onClick={() => onRestore(r.runId)}
            testId="deleted-restore"
          >
            Restore
          </Button>
        )}
      </td>
    </tr>
  );
}
