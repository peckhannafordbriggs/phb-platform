import "./load-env";
import { Prisma } from "../lib/generated/prisma/client";
import { createDbClient } from "./db";
import {
  LOOKBACK_DAYS,
  MIN_READINGS,
  PLAUSIBILITY_THRESHOLDS,
  STATE_DATA_TYPES,
  judgePlausibility,
  type PlausibilityRow,
  type PointPlausibility,
} from "../lib/modules/bas/plausibility";
import { plausibilityLateral } from "../lib/modules/bas/plausibility-sql";
import { withUnit } from "../lib/modules/bas/units";

/**
 * The acceptance test for the value-plausibility check, run against the REAL
 * database in DATABASE_URL and printed as Markdown. Both halves:
 *
 *   1. points_RoomT (lab) and VAV-8 104-105_ZoneTemperature (office) are
 *      flagged.
 *   2. NOT ONE setpoint or status / command point is flagged.
 *
 *   npm run bas:plausibility:verify
 *
 * It prints EVERY active point's verdict - flat, changing, too few readings,
 * or not checked and why - so anything flagged beyond the two known faults is
 * seen rather than tuned away. It reads and never writes: the one statement
 * is the same SELECT the service runs, and the counts of readings and active
 * points are taken before and after and compared. Exit code 1 if either half
 * fails or anything changed.
 *
 * The output is what docs/bas-plausibility-verification.md is written from.
 */

const MUST_FLAG = ["points_RoomT", "VAV$2d8$20104$2d105_ZoneTemperature"];

interface Row extends PlausibilityRow {
  point_id: bigint;
  station: string;
  niagara_history_name: string;
  unit: string | null;
  role_is_command: boolean | null;
  role_is_status: boolean | null;
}

function fmtValue(p: PointPlausibility, unit: string | null): string {
  const v = p.value;
  if (v === null) return "—";
  if (v.num !== null) return withUnit(String(v.num), unit);
  if (v.bool !== null) return String(v.bool);
  if (v.str !== null) return v.str;
  return "no value";
}

function fmtHours(h: number | null): string {
  if (h === null) return "—";
  return h < 48 ? `${h.toFixed(1)} h` : `${(h / 24).toFixed(1)} d`;
}

async function main(): Promise<void> {
  const db = createDbClient();
  const stamp = new Date().toISOString();

  const before = await db.$queryRaw<Array<{ readings: bigint; active: bigint }>>`
    SELECT (SELECT count(*) FROM bas_readings) AS readings,
           (SELECT count(*) FROM bas_points WHERE is_active) AS active`;

  const started = process.hrtime.bigint();
  const rows = await db.$queryRaw<Row[]>`
    SELECT
      p.point_id,
      st.niagara_station_name AS station,
      p.niagara_history_name,
      p.unit,
      p.is_active,
      p.data_type,
      p.point_role,
      pr.is_setpoint  AS role_is_setpoint,
      pr.is_command   AS role_is_command,
      pr.is_status    AS role_is_status,
      pr.measurement  AS role_measurement,
      p.collection_interval_s,
      c.last_run_at,
      c.last_status,
      pl.*
    FROM bas_points p
    JOIN bas_stations st ON st.station_id = p.station_id
    LEFT JOIN bas_point_roles pr ON pr.point_role = p.point_role
    LEFT JOIN bas_sync_checkpoints c ON c.point_id = p.point_id
    ${plausibilityLateral(Prisma.sql`p`, Prisma.sql`pr`)}
    WHERE p.is_active
    ORDER BY st.niagara_station_name, p.niagara_history_name`;
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;

  const after = await db.$queryRaw<Array<{ readings: bigint; active: bigint }>>`
    SELECT (SELECT count(*) FROM bas_readings) AS readings,
           (SELECT count(*) FROM bas_points WHERE is_active) AS active`;

  console.log(`# Value plausibility - live verification - ${stamp}`);
  console.log("");
  console.log(
    `Thresholds: ${PLAUSIBILITY_THRESHOLDS.map((t) => `${t.measurement} ${t.hours} h`).join(", ")}. ` +
      `Minimum readings ${MIN_READINGS}. Lookback ${LOOKBACK_DAYS} days.`,
  );
  console.log(`Active points: ${rows.length}. Query round trip: ${elapsedMs.toFixed(1)} ms.`);
  console.log("");
  console.log("| Station | Point | Role | Kind | Verdict | Flat | Value | Last different | Readings |");
  console.log("|---|---|---|---|---|---|---|---|---|");

  const flagged: Row[] = [];
  const failures: string[] = [];

  for (const row of rows) {
    const p = judgePlausibility(row);
    const verdict =
      p.state === "not_checked"
        ? `not checked, ${p.notCheckedReason?.replace("_", " ")}`
        : p.state === "too_few_readings"
          ? `too few readings (${p.readings})`
          : p.state === "moving"
            ? "changing"
            : "FLAT";
    const lastDifferent =
      p.lastDifferentAt !== null
        ? `${p.lastDifferentAt} (${p.lastDifferentValue?.num ?? p.lastDifferentValue?.str ?? p.lastDifferentValue?.bool ?? "no value"})`
        : p.state === "flat" || p.state === "moving"
          ? p.lookbackExhausted
            ? `none in ${LOOKBACK_DAYS} d`
            : "never"
          : "—";
    console.log(
      `| ${row.station} | ${row.niagara_history_name} | ${row.point_role ?? "—"} | ` +
        `${p.measurement ?? "—"}${p.trendKind === "cov" ? " (COV)" : ""} | ${verdict} | ` +
        `${p.state === "flat" || p.state === "moving" ? `${p.lookbackExhausted ? "≥ " : ""}${fmtHours(p.flatHours)} of ${fmtHours(p.thresholdHours)}` : "—"} | ` +
        `${p.state === "flat" || p.state === "moving" ? fmtValue(p, row.unit) : "—"} | ${lastDifferent} | ${p.readings ?? "—"} |`,
    );

    if (p.state === "flat") {
      flagged.push(row);
      if (row.role_is_setpoint) failures.push(`setpoint flagged: ${row.niagara_history_name}`);
      if (row.role_is_status || row.role_measurement === "status" || row.role_measurement === "mode") {
        failures.push(`status point flagged: ${row.niagara_history_name}`);
      }
      if (row.point_role === null) failures.push(`point with no role flagged: ${row.niagara_history_name}`);
      if (STATE_DATA_TYPES.includes(row.data_type)) {
        failures.push(`state-typed point (${row.data_type}) flagged: ${row.niagara_history_name}`);
      }
    }
  }

  for (const name of MUST_FLAG) {
    if (!flagged.some((r) => r.niagara_history_name === name)) {
      failures.push(`known dead sensor NOT flagged: ${name}`);
    }
  }

  const extra = flagged.filter((r) => !MUST_FLAG.includes(r.niagara_history_name));

  console.log("");
  console.log(`## Flagged: ${flagged.length}`);
  for (const r of flagged) console.log(`- ${r.station} / ${r.niagara_history_name} (${r.point_role})`);
  console.log("");
  console.log(
    extra.length === 0
      ? "Nothing flagged beyond the two known faults."
      : `## Flagged beyond the two known faults: ${extra.length} - look at these, do not tune them away\n` +
          extra.map((r) => `- ${r.station} / ${r.niagara_history_name} (${r.point_role})`).join("\n"),
  );

  if (before[0]?.readings !== after[0]?.readings || before[0]?.active !== after[0]?.active) {
    failures.push("the check changed the database: readings or active points differ before and after");
  }

  console.log("");
  console.log(
    `Readings before ${before[0]?.readings} after ${after[0]?.readings}; ` +
      `active points before ${before[0]?.active} after ${after[0]?.active}.`,
  );
  console.log("");
  if (failures.length === 0) {
    console.log("## ACCEPTANCE: PASS - both known faults flagged; no setpoint, status or unclassified point flagged.");
  } else {
    console.log("## ACCEPTANCE: FAIL");
    for (const f of failures) console.log(`- ${f}`);
  }

  await db.$disconnect();
  if (failures.length > 0) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
