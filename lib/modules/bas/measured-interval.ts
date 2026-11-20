import { prisma } from "@/lib/db";
import {
  MEASURED_INTERVAL_WINDOW_DAYS,
  SPACING_TOLERANCE,
  storedIntervalFor,
  type SpacingSummary,
} from "./interval";

/**
 * The scheduler's interval step (2026-11-20): measure how often every
 * collected point actually reports, and store it on the point as
 * `bas_points.measured_interval_s`, so Collection Health, the roll horizon in
 * bas_v_collection_health, the reports and the collector's roll guard all use
 * the same number Point Explorer shows.
 *
 * The rule is interval.ts's, applied to the last seven days of readings:
 *
 *   even          the median gap is stored
 *   uneven        NULL is stored - a change-of-value trend has no interval
 *   insufficient  nothing is written - a point that went quiet keeps the
 *                 interval it had, and a new one waits for ten gaps
 *
 * One aggregate statement for the measurement, one UPDATE for the rows whose
 * value actually changes - most passes write nothing. Never touches
 * collection_interval_s, which is what Workbench says (the 2026-09-18 rule in
 * add_bas_shortest_full_span).
 *
 * Runs in the BAS Reports scheduler job (scripts/bas-reports-scheduler.ts),
 * after the reports and the assignment pass. Imports nothing from
 * lib/env.ts: the job's import graph is walked by
 * tests/bas-reports-jobs-env.test.ts.
 */

export interface IntervalRefresh {
  /** Active points with readings in the window. */
  measured: number;
  /** Rows whose stored interval changed: newly measured, changed, or cleared. */
  changed: number;
  /** Of those, how many were set to NULL because the spacing turned out uneven. */
  cleared: number;
}

interface MeasuredRow {
  point_id: bigint;
  stored: number | null;
  gaps: number;
  median_s: number | null;
  within: number;
}

export async function refreshMeasuredIntervals(now: Date = new Date()): Promise<IntervalRefresh> {
  const since = new Date(now.getTime() - MEASURED_INTERVAL_WINDOW_DAYS * 86_400_000);

  const rows = await prisma.$queryRaw<MeasuredRow[]>`
    WITH d AS (
      SELECT r.point_id,
             EXTRACT(EPOCH FROM (r.ts - lag(r.ts) OVER (PARTITION BY r.point_id ORDER BY r.ts)))::float8 AS gap
        FROM bas_readings r
        JOIN bas_points p ON p.point_id = r.point_id
       WHERE p.is_active AND r.ts >= ${since} AND r.ts < ${now}
    ), g AS (
      SELECT point_id, gap FROM d WHERE gap > 0
    ), m AS (
      SELECT point_id,
             count(*)::int AS n,
             percentile_disc(0.5) WITHIN GROUP (ORDER BY gap)::float8 AS median
        FROM g
       GROUP BY point_id
    )
    SELECT m.point_id,
           p.measured_interval_s AS stored,
           m.n AS gaps,
           m.median AS median_s,
           count(*) FILTER (WHERE abs(g.gap - m.median) <= ${SPACING_TOLERANCE}::float8 * m.median)::int AS within
      FROM m
      JOIN g USING (point_id)
      JOIN bas_points p ON p.point_id = m.point_id
     GROUP BY m.point_id, p.measured_interval_s, m.n, m.median
  `;

  const ids: bigint[] = [];
  const values: Array<number | null> = [];
  let cleared = 0;
  for (const row of rows) {
    const summary: SpacingSummary = { gaps: row.gaps, medianS: row.median_s, withinTolerance: row.within };
    const next = storedIntervalFor(summary);
    if (next === undefined || next === row.stored) continue;
    ids.push(row.point_id);
    values.push(next);
    if (next === null) cleared += 1;
  }

  if (ids.length > 0) {
    // One statement for every changed row. The arrays travel as parameters;
    // the cast on the second keeps a NULL a NULL.
    await prisma.$executeRaw`
      UPDATE bas_points p
         SET measured_interval_s = v.interval_s
        FROM unnest(${ids}::bigint[], ${values}::int[]) AS v(point_id, interval_s)
       WHERE p.point_id = v.point_id
         AND p.measured_interval_s IS DISTINCT FROM v.interval_s
    `;
  }

  return { measured: rows.length, changed: ids.length, cleared };
}
