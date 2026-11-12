import type { Viewer } from "@/lib/authz";
import { prisma } from "@/lib/db";
import {
  DAY_MS,
  USAGE_RANGES,
  USAGE_ZONE,
  addToTally,
  dayKey,
  monthLabel,
  rangeDays,
  tallyRows,
  type Tally,
  type UsageDay,
  type UsageMonth,
  type UsageRange,
  type UsageRow,
  type UsageTotals,
} from "@/lib/usage/range";
import type { SafetyCeilingView } from "./ceiling";
import { readSafetyCeiling } from "./ceiling-read";
import type { RunStatus } from "./engine/types";
import { visibilityWhere } from "./runs-service";
import { zonedDateTimeToUtc } from "./schedule";

/**
 * Usage & cost for the Reports tab (2026-11-12), on the Cost Intelligence
 * page's shape: spend, runs, tokens and the month so far over 7 / 30 / 90
 * days, spend per day, a breakdown by report and by building, and the most
 * expensive runs. The source is `bas_report_runs` - every run that has
 * FINISHED (succeeded, partial or failed), counted on the day it finished,
 * with the cost and tokens the engine metered onto the row. A queued or
 * running run has spent nothing yet and is not a row here.
 *
 * Until this existed the Usage page was a Phase 1 placeholder that said
 * "There have been no runs" without asking - which is what the page read
 * while the Reports list beside it showed a succeeded run with a cost. The
 * visibility is the runs list's own (`visibilityWhere`): a person sees
 * their reports' spend, a module admin sees every report's.
 *
 * Days are America/New_York, the company's clock, whatever the viewer's.
 */

export interface ReportsUsageRun {
  runId: string;
  reportId: string;
  reportName: string;
  buildingName: string;
  status: RunStatus;
  startedAt: string | null;
  finishedAt: string;
  tokens: number;
  spend: number;
}

export interface ReportsUsage {
  range: UsageRange;
  totals: UsageTotals;
  thisMonth: UsageMonth;
  days: UsageDay[];
  byReport: UsageRow[];
  byBuilding: UsageRow[];
  topRuns: ReportsUsageRun[];
  /**
   * Finished runs the viewer may see in the range, counted with no joins
   * over the same cut - the guard every BAS list carries, so the page can
   * say in red when the figures lost a row.
   */
  runsInDatabase: number;
  ceiling: SafetyCeilingView;
}

const FINISHED: RunStatus[] = ["succeeded", "partial", "failed"];

function toStatus(value: string): RunStatus {
  return value === "queued" || value === "running" || value === "succeeded" || value === "partial" ? value : "failed";
}

/** Midnight in New York at the start of a YYYY-MM-DD day, as an instant. */
function dayStart(date: string): Date {
  const [year, month, day] = date.split("-").map(Number) as [number, number, number];
  return zonedDateTimeToUtc({ year, month, day, hour: 0, minute: 0 }, USAGE_ZONE);
}

export async function getReportsUsage(viewer: Viewer, range: UsageRange, now = new Date()): Promise<ReportsUsage> {
  const count = USAGE_RANGES[range];
  const today = dayKey(now);
  const days = rangeDays(today, count);
  const first = days[0]!.date;
  const month = today.slice(0, 7);
  const rangeStart = dayStart(first);

  const visible = await visibilityWhere(viewer);
  // Wide enough for the range and the whole current month, so "this month"
  // can be summed from the same rows; the day keys do the exact cut.
  const since = new Date(Math.min(rangeStart.getTime(), dayStart(`${month}-01`).getTime()) - DAY_MS);

  const [rows, runsInDatabase, ceiling] = await Promise.all([
    prisma.basReportRun.findMany({
      where: { ...visible, status: { in: FINISHED }, finishedAt: { gte: since } },
      select: {
        runId: true,
        reportId: true,
        status: true,
        startedAt: true,
        finishedAt: true,
        costUsd: true,
        inputTokens: true,
        outputTokens: true,
        report: { select: { name: true, site: { select: { name: true } } } },
      },
      orderBy: [{ finishedAt: "desc" }, { runId: "desc" }],
    }),
    prisma.basReportRun.count({
      where: { ...visible, status: { in: FINISHED }, finishedAt: { gte: rangeStart, lte: now } },
    }),
    readSafetyCeiling(prisma),
  ]);

  const perDay = new Map<string, number>();
  const byReport: Tally = new Map();
  const byBuilding: Tally = new Map();
  const runs: ReportsUsageRun[] = [];
  let thisMonth = 0;

  for (const r of rows) {
    if (r.finishedAt === null || r.finishedAt.getTime() > now.getTime()) continue;
    const spend = Number(r.costUsd);
    const tokens = r.inputTokens + r.outputTokens;
    const key = dayKey(r.finishedAt);
    if (key.startsWith(month)) thisMonth += spend;
    if (key < first) continue;

    const runId = r.runId.toString();
    perDay.set(key, (perDay.get(key) ?? 0) + spend);
    addToTally(byReport, r.report.name, runId, tokens, spend);
    addToTally(byBuilding, r.report.site.name, runId, tokens, spend);
    runs.push({
      runId,
      reportId: r.reportId.toString(),
      reportName: r.report.name,
      buildingName: r.report.site.name,
      status: toStatus(r.status),
      startedAt: r.startedAt?.toISOString() ?? null,
      finishedAt: r.finishedAt.toISOString(),
      tokens,
      spend,
    });
  }

  return {
    range,
    totals: {
      runs: runs.length,
      tokens: runs.reduce((a, r) => a + r.tokens, 0),
      spend: runs.reduce((a, r) => a + r.spend, 0),
    },
    thisMonth: { label: monthLabel(month), spend: thisMonth },
    days: days.map((d) => ({ ...d, spend: perDay.get(d.date) ?? 0 })),
    byReport: tallyRows(byReport),
    byBuilding: tallyRows(byBuilding),
    topRuns: [...runs].sort((a, b) => b.spend - a.spend || b.finishedAt.localeCompare(a.finishedAt)).slice(0, 10),
    runsInDatabase,
    ceiling,
  };
}
