import { Prisma } from "@/lib/generated/prisma/client";
import { LOOKBACK_DAYS, MIN_READINGS, PLAUSIBILITY_THRESHOLDS } from "./plausibility";

/**
 * The SQL half of the value-plausibility check. In a file of its own because
 * it imports the Prisma client, and plausibility.ts - the thresholds, the
 * vocabulary and the judge - is imported by the browser bundle through
 * app/(modules)/bas/health-client.ts. Next refuses to bundle node:fs into a
 * client component, which is how this split was found: the first build.
 * Nothing here is imported by anything that renders.
 */

/**
 * THE decision of which points are evaluated, as SQL, generated from the
 * threshold table and the setpoint flag. `pr` is the bas_point_roles alias,
 * LEFT-joined, so a point with no role yields NULL here and is skipped.
 *
 * This is the "role exclusion" the acceptance test mutates: drop
 * `NOT is_setpoint` and every flat setpoint is flagged; drop the IN list and
 * every status point with a long quiet stretch is.
 */
export function checkedRoleSql(pr: Prisma.Sql): Prisma.Sql {
  const kinds = PLAUSIBILITY_THRESHOLDS.map((t) => t.measurement);
  return Prisma.sql`(${pr}.measurement IN (${Prisma.join(kinds)}) AND NOT ${pr}.is_setpoint)`;
}

/**
 * `LEFT JOIN LATERAL (...) pl ON true`, computing PlausibilityFacts for one
 * point per outer row. `p` is the bas_points alias, `pr` the bas_point_roles
 * alias.
 *
 * The role condition is inside the one-row source (`SELECT 1 WHERE ...`), not
 * in a trailing WHERE: with zero source rows the nested loops beneath it never
 * run, so a point that is not checked costs nothing. With it as a filter on
 * top, PostgreSQL may evaluate the index probes first and discard the row.
 *
 * Four probes per point, each a backward scan of the (point_id, ts) key:
 *
 *   latest   the newest reading
 *   diff     the newest reading OLDER than it whose value differs, inside the
 *            lookback. IS DISTINCT FROM on all three value columns, so a run of
 *            empty records is a run
 *   run      how many readings are newer than diff (or than the lookback start
 *            when there is no diff), and the oldest of them: when the value
 *            became what it is
 *   hist     the oldest reading of all, to tell "never different" from
 *            "not different inside the lookback"
 *
 * plus the readings inside the lookback window for the MIN_READINGS guard,
 * counted through a LIMIT so it reads at most MIN_READINGS rows.
 */
export function plausibilityLateral(p: Prisma.Sql, pr: Prisma.Sql): Prisma.Sql {
  const lookback = Prisma.sql`make_interval(days => ${LOOKBACK_DAYS}::int)`;
  return Prisma.sql`
    LEFT JOIN LATERAL (
      SELECT
        true                AS pl_checked,
        latest.ts           AS pl_last_ts,
        latest.value_num    AS pl_value_num,
        latest.value_bool   AS pl_value_bool,
        latest.value_str    AS pl_value_str,
        diff.ts             AS pl_diff_ts,
        diff.value_num      AS pl_diff_num,
        diff.value_bool     AS pl_diff_bool,
        diff.value_str      AS pl_diff_str,
        run.n               AS pl_run_readings,
        run.first_ts        AS pl_flat_since,
        hist.first_ts       AS pl_history_start,
        win.n               AS pl_window_readings
      FROM (SELECT 1 WHERE ${p}.is_active AND ${checkedRoleSql(pr)}) AS checked
      LEFT JOIN LATERAL (
        SELECT r.ts, r.value_num, r.value_bool, r.value_str
          FROM bas_readings r
         WHERE r.point_id = ${p}.point_id
         ORDER BY r.ts DESC
         LIMIT 1
      ) latest ON true
      LEFT JOIN LATERAL (
        SELECT r.ts, r.value_num, r.value_bool, r.value_str
          FROM bas_readings r
         WHERE r.point_id = ${p}.point_id
           AND r.ts < latest.ts
           AND r.ts >= latest.ts - ${lookback}
           AND (   r.value_num  IS DISTINCT FROM latest.value_num
                OR r.value_bool IS DISTINCT FROM latest.value_bool
                OR r.value_str  IS DISTINCT FROM latest.value_str)
         ORDER BY r.ts DESC
         LIMIT 1
      ) diff ON true
      LEFT JOIN LATERAL (
        SELECT count(*)::int AS n, min(r.ts) AS first_ts
          FROM bas_readings r
         WHERE r.point_id = ${p}.point_id
           AND r.ts > COALESCE(diff.ts, latest.ts - ${lookback})
           AND r.ts <= latest.ts
      ) run ON true
      LEFT JOIN LATERAL (
        SELECT min(r.ts) AS first_ts
          FROM bas_readings r
         WHERE r.point_id = ${p}.point_id
      ) hist ON true
      LEFT JOIN LATERAL (
        SELECT count(*)::int AS n
          FROM (
            SELECT 1
              FROM bas_readings r
             WHERE r.point_id = ${p}.point_id
               AND r.ts >= latest.ts - ${lookback}
             LIMIT ${MIN_READINGS}::int
          ) AS enough
      ) win ON true
    ) pl ON true`;
}

