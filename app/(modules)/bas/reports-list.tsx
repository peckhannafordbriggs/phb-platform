"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { pageWindow, parsePage } from "@/lib/modules/bas/reports/paging";
import {
  REPORT_DELETE_IN_FLIGHT_TITLE,
  describeRunRetention,
  reportDeleteHeading,
  reportDeleteSentence,
} from "@/lib/modules/bas/reports/deletion-words";
import { REPORT_STATE_LABELS, type ReportSummary, type ReportsList } from "@/lib/modules/bas/reports/types";
import { ApiError } from "./health-client";
import {
  changeReportState,
  deleteReport,
  describeLastRun,
  describeNextRun,
  describeRecipients,
  describeStations,
  fetchReports,
  reportStateTone,
  requestRun,
} from "./reports-client";
import { Button } from "@/components/ui";
import { ConfirmDialog } from "./reports-confirm";
import { lostRowsSentence } from "./reports-generated";
import { ListPager } from "./reports-pager";
import { TONE_INK, TONE_STYLE } from "./tone";

/**
 * Scheduled, on the Reports bar (the Reports sub-tab until 2026-11-11): the
 * reports the viewer may see, one row each, with the columns the plan
 * names. "Run now" (Phase 3) queues a run for the worker and the Last run
 * cell shows it Queued, then Running, then its outcome; the list is reloaded
 * every ten seconds while a run of any report is in flight, so the change is
 * seen without a refresh.
 *
 * Paged (2026-11-23): 25 a page, newest first, "1–25 of N" with Previous
 * and Next under the table, the page in the URL (`?page=`).
 *
 * Delete (2026-11-20) opens a confirmation that says future runs stop and
 * names how many generated reports stay; the report leaves this list for
 * everyone, and its runs stay on the Reports list, "(schedule deleted)". It
 * is greyed while a run of the report is queued or running.
 */
export function ReportsListView() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const askedPage = parsePage(searchParams.get("page"));
  const [data, setData] = useState<ReportsList | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState<ReportSummary | null>(null);

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const next = await fetchReports(askedPage, signal);
      setData(next);
      // The server held the page to the last one: say so in the URL too.
      if (next.page !== askedPage) router.replace(next.page <= 1 ? "/bas/reports/scheduled" : `/bas/reports/scheduled?page=${next.page}`, { scroll: false });
      setError(null);
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === "AbortError") return;
      setError(cause instanceof ApiError ? cause : new ApiError("unexpected", "Something went wrong."));
    }
  }, [askedPage, router]);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  // While any report has a run queued or running, reload every ten seconds
  // (only while the tab is visible), so Run now is seen to start and finish.
  const inFlight = data?.reports.some((r) => r.lastRun !== null && (r.lastRun.status === "queued" || r.lastRun.status === "running")) ?? false;
  useEffect(() => {
    if (!inFlight) return;
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, LIST_POLL_MS);
    return () => clearInterval(timer);
  }, [inFlight, load]);

  const run = useCallback(
    async (action: () => Promise<unknown>) => {
      setBusy(true);
      setError(null);
      try {
        await action();
        await load();
      } catch (cause) {
        setError(cause instanceof ApiError ? cause : new ApiError("unexpected", "Something went wrong."));
      } finally {
        setBusy(false);
      }
    },
    [load],
  );

  if (data === null) {
    return <p className="p-6 text-sm text-[var(--muted)]">{error?.message ?? "Loading reports…"}</p>;
  }

  return (
    <div className="space-y-4">
      {error !== null && (
        <p className="rounded-[var(--radius-row)] border p-4 text-sm" style={TONE_STYLE.bad} role="alert">
          {error.message}
        </p>
      )}
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-[var(--muted)]">
          {data.canAdminister ? "Every report, as a module admin." : "Your reports."}
        </p>
        <Button size="sm" href="/bas/reports/new" className="font-medium">
          New report
        </Button>
      </div>
      <ReportsTable
        data={data}
        busy={busy}
        onPause={(id) => run(() => changeReportState(id, "pause"))}
        onResume={(id) => run(() => changeReportState(id, "resume"))}
        onRunNow={(id) => run(() => requestRun(id))}
        onDelete={(id) => setConfirming(data.reports.find((r) => r.reportId === id) ?? null)}
        onPage={(page) => router.replace(page <= 1 ? "/bas/reports/scheduled" : `/bas/reports/scheduled?page=${page}`, { scroll: false })}
      />
      {confirming !== null && (
        <ConfirmDialog
          heading={reportDeleteHeading(confirming.name)}
          sentence={reportDeleteSentence(confirming.runCount)}
          confirmLabel="Delete report"
          busyLabel="Deleting…"
          busy={busy}
          testIdPrefix="report-delete"
          onCancel={() => setConfirming(null)}
          onConfirm={() => {
            const id = confirming.reportId;
            void run(() => deleteReport(id)).then(() => setConfirming(null));
          }}
        />
      )}
    </div>
  );
}

/** How often the list reloads while a run is in flight. */
const LIST_POLL_MS = 10_000;

/** The table, from a payload. Pure, so a node test can render it. */
export function ReportsTable({
  data,
  busy = false,
  onPause,
  onResume,
  onRunNow,
  onDelete,
  onPage,
}: {
  data: ReportsList;
  busy?: boolean;
  onPause?: (reportId: string) => void;
  onResume?: (reportId: string) => void;
  onRunNow?: (reportId: string) => void;
  onDelete?: (reportId: string, name: string) => void;
  onPage?: (page: number) => void;
}) {
  if (data.reports.length === 0 && data.reportsInDatabase === 0) {
    return (
      <section className="card p-8 text-center">
        <p className="text-sm font-medium">No reports yet</p>
        <p className="mt-1 text-sm text-[var(--muted)]">
          A report is a fixed set of questions asked of one building on a schedule. Create one to
          start; it stays a draft until you activate it.
        </p>
      </section>
    );
  }

  const expected = pageWindow(data.page, data.reportsInDatabase, data.pageSize).expectedRows;
  return (
    <section className="card p-0">
      {data.reports.length !== expected && (
        <p className="m-4 rounded-[var(--radius-row)] border p-3 text-sm" style={TONE_STYLE.bad} role="alert">
          {lostRowsSentence(data.reports.length, expected, data.reportsInDatabase, "reports")} Report this - a report
          missing here may still be scheduled.
        </p>
      )}
      <div className="max-h-[32rem] overflow-auto">
        <table className="w-full text-[0.8125rem]">
          <thead className="sticky top-0 z-10 bg-[var(--surface)] text-left text-[var(--muted)]">
            <tr>
              <th className="eyebrow px-4 py-2.5 text-[var(--muted)]">Report</th>
              <th className="eyebrow py-2.5 pr-3 text-[var(--muted)]">Building</th>
              <th className="eyebrow py-2.5 pr-3 text-[var(--muted)]">Schedule</th>
              <th className="eyebrow py-2.5 pr-3 text-[var(--muted)]">Questions</th>
              <th className="eyebrow py-2.5 pr-3 text-[var(--muted)]">Next run</th>
              <th className="eyebrow py-2.5 pr-3 text-[var(--muted)]">Last run</th>
              <th className="eyebrow py-2.5 pr-3 text-[var(--muted)]">Recipients</th>
              <th className="eyebrow py-2.5 pr-3 text-[var(--muted)]">State</th>
              <th className="eyebrow py-2.5 pr-4 text-[var(--muted)]">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {data.reports.map((r) => (
              <ReportRow
                key={r.reportId}
                report={r}
                showOwner={data.canAdminister}
                busy={busy}
                onPause={onPause}
                onResume={onResume}
                onRunNow={onRunNow}
                onDelete={onDelete}
              />
            ))}
          </tbody>
        </table>
      </div>
      <ListPager page={data.page} pageSize={data.pageSize} total={data.reportsInDatabase} label="Reports pages" onPage={onPage} />
    </section>
  );
}

function ReportRow({
  report: r,
  showOwner,
  busy,
  onPause,
  onResume,
  onRunNow,
  onDelete,
}: {
  report: ReportSummary;
  showOwner: boolean;
  busy: boolean;
  onPause?: (reportId: string) => void;
  onResume?: (reportId: string) => void;
  onRunNow?: (reportId: string) => void;
  onDelete?: (reportId: string, name: string) => void;
}) {
  const tone = reportStateTone(r.state);
  const inFlight = r.lastRun !== null && (r.lastRun.status === "queued" || r.lastRun.status === "running");
  return (
    <tr className="border-t border-[var(--divider-soft)] align-top">
      <td className="px-4 py-3">
        <Link href={`/bas/reports/${encodeURIComponent(r.reportId)}`} className="font-medium hover:underline">
          {r.name}
        </Link>
        {/* The summary line: the preset label, and how long runs are kept when that is not for ever (2026-11-20). */}
        {(r.presetLabel !== null || r.runRetentionMonths !== null) && (
          <div className="text-[var(--muted)]" data-testid="report-summary-line">
            {[r.presetLabel, describeRunRetention(r.runRetentionMonths)].filter((x): x is string => x !== null).join(" · ")}
          </div>
        )}
        {showOwner && !r.isOwner && <div className="text-[var(--muted)]">Owner: {r.ownerName}</div>}
      </td>
      <td className="py-3 pr-3">
        {r.site.name}
        <div className="text-[var(--muted)]">{describeStations(r.stationsSelected, r.stationsOnSite)}</div>
      </td>
      <td className="py-3 pr-3">{r.scheduleText}</td>
      <td className="py-3 pr-3 tabular-nums">{r.questionCount}</td>
      <td className="py-3 pr-3">{r.state === "active" ? describeNextRun(r.nextRunAt, r.site.timezone) : "—"}</td>
      <td className="py-3 pr-3">
        {r.lastRun === null ? (
          <span className="text-[var(--muted)]">No runs yet</span>
        ) : (
          <Link href={`/bas/reports/generated/${encodeURIComponent(r.lastRun.runId)}`} className="hover:underline" title={r.lastRun.partialReason ?? r.lastRun.error ?? undefined}>
            {describeLastRun(r.lastRun)}
          </Link>
        )}
      </td>
      <td className="py-3 pr-3">{describeRecipients(r.recipientCount)}</td>
      <td className="py-3 pr-3">
        <span
          className="inline-block rounded-full border px-2 py-0.5 text-[0.6875rem] font-medium"
          style={{ ...TONE_STYLE[tone], color: TONE_INK[tone] }}
        >
          {REPORT_STATE_LABELS[r.state]}
        </span>
        {r.pausedReason !== null && <div className="mt-1 max-w-[16rem] text-[var(--muted)]">{r.pausedReason}</div>}
      </td>
      <td className="py-3 pr-4">
        <div className="flex flex-wrap gap-1">
          <Button size="sm" href={`/bas/reports/${encodeURIComponent(r.reportId)}`}>
            Edit
          </Button>
          {onRunNow !== undefined && (
            <Button
              size="sm"
              disabled={busy || inFlight || r.questionCount === 0}
              title={inFlight ? "A run is already queued or running." : r.questionCount === 0 ? "Add a question first." : undefined}
              onClick={() => onRunNow(r.reportId)}
            >
              {inFlight ? (r.lastRun?.status === "running" ? "Running…" : "Queued…") : "Run now"}
            </Button>
          )}
          {r.state === "active" && onPause !== undefined && (
            <Button size="sm"  disabled={busy} onClick={() => onPause(r.reportId)}>
              Pause
            </Button>
          )}
          {r.state === "paused" && onResume !== undefined && (
            <Button size="sm"  disabled={busy} onClick={() => onResume(r.reportId)}>
              Resume
            </Button>
          )}
          {onDelete !== undefined && (
            <Button
              size="sm"
              disabled={busy || inFlight}
              title={inFlight ? REPORT_DELETE_IN_FLIGHT_TITLE : undefined}
              onClick={() => onDelete(r.reportId, r.name)}
              testId="report-delete"
            >
              Delete
            </Button>
          )}
        </div>
      </td>
    </tr>
  );
}
