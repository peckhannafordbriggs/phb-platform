import { Prisma } from "@/lib/generated/prisma/client";
import type { Viewer } from "@/lib/authz";
import { prisma } from "@/lib/db";
import { readAnthropicApiKey } from "@/lib/env";
import { logger } from "@/lib/logger";
import { distinctValuesTone } from "@/app/(modules)/bas/health-client";
import { QuestionRateLimiter } from "../analyze/rate-limit";
import { readSafetyCeiling } from "../reports/ceiling-read";
import { describeSafetyCeiling } from "../reports/ceiling";
import { occupiedFromSchedule } from "../reports/engine/series";
import { getPointExplorer, type CustomRangeRequest } from "../service";
import { computeTrendStats, type OccupiedInterval, type TrendStats } from "./stats";
import type { TrendSummaryResult, TrendSummaryState } from "./types";

export type { TrendSummaryResult, TrendSummaryState } from "./types";
import { createAnthropicTrendNarrator, type TrendNarrator } from "./narrator";

/**
 * "Explain this trend" (2026-11-20): on demand, for the point and range on
 * screen, 3-5 sentences from the model over numbers code computed.
 *
 *   1. The page's own read of the point (`getPointExplorer`), so the summary
 *      describes exactly what the chart shows: the same range in the
 *      building's zone, the same samples, the same expected interval and
 *      breaks, the same physical-range flag. It also refuses the same points
 *      the page refuses, with the same words.
 *   2. The CACHE: the newest row in bas_trend_summaries for this point, this
 *      range (days:N, or the two dates) and this newest reading. A new
 *      reading makes it stale; Refresh writes a new one regardless.
 *   3. The stats (stats.ts), with occupancy from the station's trended
 *      occupancy point, else the building's occupied hours, else none.
 *   4. The module's SAFETY CEILING, the Reports one (reports/ceiling.ts):
 *      a call whose estimate is over its dollars is not made, and its
 *      minutes bound the call's timeout. Then six calls a minute per person.
 *   5. One row per call - written, withheld or failed - with the tokens and
 *      the dollars, which the Usage page sums under "Trend summaries".
 *
 * Module access only, like the page. No audit row: the table row is the
 * record of who asked, and the audit screen shows account events only.
 */

export interface TrendSummaryRequest {
  pointId: bigint;
  windowDays: number;
  range: CustomRangeRequest | null;
  /** Write a new one even when the cache holds one for the same data. */
  refresh: boolean;
}

export interface TrendSummaryDeps {
  narrator?: TrendNarrator;
  /** Overrides the environment's key; `null` reads as not configured. */
  apiKey?: string | null;
  limiter?: QuestionRateLimiter;
}

/** Six model calls a minute per person, the Analyze tab's limit. Cache hits are free. */
export const trendSummaryLimiter = new QuestionRateLimiter({ limit: 6, windowMs: 60_000 });

/** The longest a call may take, whatever the ceiling allows. */
const MAX_CALL_MS = 120_000;
/** An occupancy reading holds for at most this long; past it the state is not known. */
const OCCUPANCY_MAX_HOLD_MS = 24 * 3_600_000;

export function rangeKeyOf(request: Pick<TrendSummaryRequest, "windowDays" | "range">): string {
  return request.range === null ? `days:${request.windowDays}` : `dates:${request.range.from}..${request.range.to}`;
}

export async function summariseTrend(
  viewer: Viewer,
  request: TrendSummaryRequest,
  deps: TrendSummaryDeps = {},
): Promise<TrendSummaryResult> {
  const explorer = await getPointExplorer(viewer, {
    pointId: request.pointId,
    windowDays: request.windowDays,
    range: request.range,
  });
  const point = explorer.selectedPoint;
  // getPointExplorer refuses a point it cannot show; reaching here without
  // one is a range that resolved nothing, which it also refuses.
  if (point === null) throw new Error("trend summary: no point selected");

  const from = new Date(explorer.range.from);
  const to = new Date(explorer.range.to);
  const zone = explorer.range.timezone;
  const rangeKey = rangeKeyOf(request);
  const base = {
    rangeFrom: explorer.range.from,
    rangeTo: explorer.range.to,
    timezone: zone,
  };
  const none = (state: TrendSummaryState, message: string, extra: Partial<TrendSummaryResult> = {}): TrendSummaryResult => ({
    state,
    summary: null,
    message,
    ...base,
    newestReadingAt: null,
    generatedAt: null,
    cached: false,
    costUsd: 0,
    model: null,
    stats: null,
    ...extra,
  });

  if (point.valueKind === "string") {
    return none("not_summarisable", "A text point has no trend to summarise.");
  }

  const newest = (
    await prisma.$queryRaw<Array<{ newest: Date | null }>>`
      SELECT max(ts) AS newest FROM bas_readings
      WHERE point_id = ${request.pointId} AND ts >= ${from} AND ts < ${to}
    `
  )[0]?.newest ?? null;
  if (newest === null || explorer.stats.readings === 0) {
    return none("no_data", "There are no readings in this range to summarise.");
  }

  // --- the cache --------------------------------------------------------
  if (!request.refresh) {
    const cached = await prisma.basTrendSummary.findFirst({
      where: { pointId: request.pointId, rangeKey, newestReadingAt: newest, summary: { not: null } },
      orderBy: { createdAt: "desc" },
    });
    if (cached !== null) {
      return {
        state: "written",
        summary: cached.summary,
        message: null,
        rangeFrom: cached.rangeFrom.toISOString(),
        rangeTo: cached.rangeTo.toISOString(),
        timezone: zone,
        newestReadingAt: newest.toISOString(),
        generatedAt: cached.createdAt.toISOString(),
        cached: true,
        costUsd: 0,
        model: cached.model,
        stats: cached.stats as unknown as TrendStats,
      };
    }
  }

  // --- the numbers --------------------------------------------------------
  const occupancy = zone === null ? null : await loadOccupancy(request.pointId, from, to, zone);
  const stats = computeTrendStats({
    pointName: point.pointName,
    unit: point.unit,
    valueKind: point.valueKind,
    states: point.states,
    timezone: zone ?? "UTC",
    range: { fromMs: from.getTime(), toMs: to.getTime() },
    samples: explorer.trend.filter((s) => !s.isBreak),
    bucketLabel: explorer.sampling.kind === "bucketed" ? explorer.sampling.bucketLabel : null,
    stats: {
      readings: explorer.stats.readings,
      nullRecords: explorer.stats.nullRecords,
      distinctValues: explorer.stats.distinctValues,
      average: explorer.stats.average,
      minimum: explorer.stats.minimum,
      maximum: explorer.stats.maximum,
    },
    stuck: distinctValuesTone(explorer.stats.distinctValues, explorer.stats.readings, point.valueKind) === "bad",
    expected: explorer.expectedInterval,
    breaks: explorer.breaks,
    outOfRange: explorer.outOfRange,
    occupancy,
  });

  // --- the gates, before any token is spent -------------------------------
  const apiKey = deps.apiKey !== undefined ? deps.apiKey : readAnthropicApiKey();
  if (deps.narrator === undefined && apiKey === null) {
    return none(
      "not_configured",
      "Trend summaries are not configured: the BAS module's Anthropic key is not set. runbook.md -> Trend summaries.",
      { newestReadingAt: newest.toISOString(), stats },
    );
  }
  const narrator = deps.narrator ?? createAnthropicTrendNarrator(apiKey!);

  const ceiling = await readSafetyCeiling(prisma);
  const estimate = narrator.estimate(stats);
  if (estimate > ceiling.usd) {
    return none(
      "over_ceiling",
      `Not written: it could cost about $${estimate.toFixed(2)}, over the module's safety ceiling of ${describeSafetyCeiling(ceiling)}.`,
      { newestReadingAt: newest.toISOString(), stats },
    );
  }

  const limiter = deps.limiter ?? trendSummaryLimiter;
  const verdict = limiter.check(viewer.id);
  if (!verdict.allowed) {
    return none(
      "rate_limited",
      `Six summaries a minute is the limit. Try again in ${Math.ceil(verdict.retryAfterMs / 1000)} seconds.`,
      { newestReadingAt: newest.toISOString(), stats },
    );
  }

  // --- the call, metered whatever it returns --------------------------------
  const narration = await narrator.narrate(stats, { timeoutMs: Math.min(ceiling.minutes * 60_000, MAX_CALL_MS) });

  const row = await prisma.basTrendSummary.create({
    data: {
      pointId: request.pointId,
      rangeKey,
      rangeFrom: from,
      rangeTo: to,
      newestReadingAt: newest,
      summary: narration.summary,
      declined: narration.summary === null ? (narration.declined ?? "No summary was written.") : null,
      stats: stats as unknown as Prisma.InputJsonValue,
      model: narrator.model,
      inputTokens: narration.usage.inputTokens,
      outputTokens: narration.usage.outputTokens,
      cacheReadTokens: narration.usage.cacheReadTokens,
      cacheWriteTokens: narration.usage.cacheWriteTokens,
      costUsd: new Prisma.Decimal(narration.costUsd.toFixed(4)),
      requestedById: viewer.id,
    },
    select: { summaryId: true, createdAt: true },
  });

  logger.info("bas.trend_summary", {
    employeeId: viewer.id,
    moduleKey: "bas",
    outcome: narration.summary === null ? "withheld" : "written",
    count: narration.usage.inputTokens + narration.usage.outputTokens,
    reason:
      `summary=${row.summaryId} point=${request.pointId} range=${rangeKey} ` +
      `cost=${narration.costUsd.toFixed(4)} refresh=${request.refresh}` +
      (narration.declined === null ? "" : ` declined=${JSON.stringify(narration.declined)}`),
  });

  return {
    state: narration.summary === null ? "withheld" : "written",
    summary: narration.summary,
    message: narration.summary === null ? narration.declined : null,
    ...base,
    newestReadingAt: newest.toISOString(),
    generatedAt: row.createdAt.toISOString(),
    cached: false,
    costUsd: narration.costUsd,
    model: narrator.model,
    stats,
  };
}

/**
 * Occupied intervals over the range: the station's trended occupancy point
 * (status first, then the command, as the reports take it), held from each
 * reading to the next for at most a day; else the building's occupied hours
 * from Settings; else null. Null too when the point being summarised IS the
 * occupancy point - occupied against unoccupied would be the point against
 * itself.
 */
async function loadOccupancy(
  pointId: bigint,
  from: Date,
  to: Date,
  zone: string,
): Promise<{ source: string; intervals: OccupiedInterval[] } | null> {
  const occupancyPoint = (
    await prisma.$queryRaw<Array<{ point_id: bigint; name: string; point_role: string; site_id: bigint }>>`
      SELECT op.point_id,
             COALESCE(op.label, op.display_name, op.niagara_history_name) AS name,
             op.point_role,
             st.site_id
        FROM bas_points p
        JOIN bas_stations st ON st.station_id = p.station_id
        LEFT JOIN bas_points op
          ON op.station_id = p.station_id
         AND op.is_active
         AND op.point_role IN ('occupancy_status', 'occupancy_cmd')
       WHERE p.point_id = ${pointId}
       ORDER BY (op.point_role = 'occupancy_status') DESC NULLS LAST, op.point_id
       LIMIT 1
    `
  )[0];
  if (occupancyPoint === undefined) return null;

  if (occupancyPoint.point_id !== null && occupancyPoint.point_id !== undefined) {
    if (occupancyPoint.point_id === pointId) return null;
    const readings = await prisma.$queryRaw<Array<{ ts: Date; v: number | null }>>`
      (SELECT ts, COALESCE(value_bool::int::float8, value_num) AS v
         FROM bas_readings WHERE point_id = ${occupancyPoint.point_id} AND ts < ${from}
        ORDER BY ts DESC LIMIT 1)
      UNION ALL
      (SELECT ts, COALESCE(value_bool::int::float8, value_num) AS v
         FROM bas_readings WHERE point_id = ${occupancyPoint.point_id} AND ts >= ${from} AND ts < ${to}
        ORDER BY ts)
    `;
    if (readings.length > 0) {
      const intervals: OccupiedInterval[] = [];
      for (let i = 0; i < readings.length; i++) {
        const r = readings[i]!;
        if (r.v === null || r.v < 0.5) continue;
        const start = Math.max(r.ts.getTime(), from.getTime());
        const next = readings[i + 1]?.ts.getTime() ?? to.getTime();
        const end = Math.min(next, r.ts.getTime() + OCCUPANCY_MAX_HOLD_MS, to.getTime());
        if (end > start) intervals.push({ start, end });
      }
      return {
        source: `${occupancyPoint.name} (${occupancyPoint.point_role === "occupancy_status" ? "occupancy status" : "occupancy command"} point)`,
        intervals,
      };
    }
  }

  const schedule = await prisma.basSiteOccupancy.findMany({
    where: { siteId: occupancyPoint.site_id },
    orderBy: { weekday: "asc" },
  });
  if (schedule.length === 0) return null;
  return {
    source: "the building's occupied hours in Settings",
    intervals: occupiedFromSchedule(
      schedule.map((r) => ({ weekday: r.weekday, startMinute: r.startMinute, endMinute: r.endMinute })),
      { start: from.getTime(), end: to.getTime() },
      zone,
    ).map((i) => ({ start: i.start, end: i.end })),
  };
}
