import type { Pool } from "pg";
import { queryAsAnalyzeRole } from "./pool";
import { unitSymbol } from "../units";

/**
 * A point's unit for the model: the stored name, which is what its SQL must
 * match against, and beside it the symbol the screens show, so an answer can
 * say "72.0 °F" the way the tiles do. Display only - the stored value is
 * carried unchanged, and a point with no unit still reads "unknown".
 */
function describeUnit(unit: string | null): string {
  if (unit === null) return "unknown";
  const symbol = unitSymbol(unit);
  return symbol === null || symbol === unit ? unit : `${unit} (shown as ${symbol})`;
}

/**
 * What the planner is told about the database, assembled from the database.
 *
 * `bas_v_data_dictionary` exists for exactly this - docs/BAS-B5.md says to
 * give the model the schema through it "rather than a hand-written description
 * that drifts". Every column comment in the migrations was written for a
 * reader like this one, and the view is what makes them reachable.
 *
 * Beside the dictionary: live row counts per object, the vocabularies with how
 * many points use each role, the sites and stations, and the points themselves
 * when there are few enough to list. The counts are what let the planner say
 * "nothing has set equipment relationships" instead of writing a join against
 * an empty table and returning zero rows about it.
 *
 * PROMPT INJECTION LIVES HERE. Point names, station names and site names come
 * from Niagara and from whoever configured it. They are rendered inside a
 * fenced data block that the system prompt names as data, never as
 * instructions, and nothing retrieved here can change what the planner is
 * allowed to do - the role decides that.
 *
 * Cached for a few minutes per process. The dictionary changes only on a
 * migration; the counts drift by the minute and nothing here needs them exact.
 */

export interface SchemaContext {
  /** The whole thing as text, ready for the system prompt. */
  text: string;
  /** For tests and the verification script. */
  objectCount: number;
  pointCount: number;
  builtAt: string;
}

const CACHE_MS = 5 * 60_000;
/** Above this, the point list is summarised per station rather than listed. */
const LIST_POINTS_UP_TO = 400;

let cached: { context: SchemaContext; expires: number; url: string } | null = null;

export function resetSchemaContextCache(): void {
  cached = null;
}

export async function getSchemaContext(
  pool: Pool,
  cacheKey: string,
): Promise<SchemaContext> {
  const now = Date.now();
  if (cached !== null && cached.expires > now && cached.url === cacheKey) {
    return cached.context;
  }
  const context = await buildSchemaContext(pool);
  cached = { context, expires: now + CACHE_MS, url: cacheKey };
  return context;
}

interface DictionaryRow {
  object_name: string;
  object_type: string;
  column_name: string;
  data_type: string;
  is_nullable: boolean;
  column_description: string | null;
  object_description: string | null;
}

interface CountRow {
  object_name: string;
  n: string;
}

interface RoleRow {
  point_role: string;
  display_name: string;
  description: string;
  measurement: string | null;
  typical_unit: string | null;
  is_setpoint: boolean;
  is_command: boolean;
  is_status: boolean;
  points: string;
}

interface SiteRow {
  site_id: string;
  site: string;
  project: string;
  org: string;
  timezone: string;
  stations: string;
  points: string;
}

interface StationRow {
  station_id: string;
  station: string;
  site: string;
  is_active: boolean;
  points: string;
  active_points: string;
}

interface PointRow {
  point_id: string;
  name: string;
  niagara_name: string;
  station: string;
  site: string;
  point_role: string | null;
  unit: string | null;
  data_type: string;
  is_active: boolean;
  inactive_reason: string | null;
  readings: string;
  first_ts: Date | null;
  last_ts: Date | null;
}

interface GapSummaryRow {
  n: string;
  hours: string | null;
  earliest: Date | null;
  latest: Date | null;
}

export async function buildSchemaContext(pool: Pool): Promise<SchemaContext> {
  const dictionary = await queryAsAnalyzeRole<DictionaryRow>(
    pool,
    `SELECT object_name, object_type, column_name, data_type, is_nullable,
            column_description, object_description
       FROM bas_v_data_dictionary`,
    [],
  );

  const objects = new Map<string, { type: string; description: string | null; columns: DictionaryRow[] }>();
  for (const row of dictionary) {
    const entry = objects.get(row.object_name) ?? {
      type: row.object_type,
      description: row.object_description,
      columns: [],
    };
    entry.columns.push(row);
    objects.set(row.object_name, entry);
  }

  // Row counts, one statement, built from the dictionary's own object names -
  // which are catalog names, not user text, and quoted anyway.
  const names = [...objects.keys()];
  const countSql = names
    .map(
      (name) =>
        `SELECT '${name}' AS object_name, count(*)::text AS n FROM public."${name.replace(/"/g, '""')}"`,
    )
    .join(" UNION ALL ");
  const counts = names.length > 0 ? await queryAsAnalyzeRole<CountRow>(pool, countSql, []) : [];
  const countOf = new Map(counts.map((c) => [c.object_name, Number(c.n)]));

  const [roles, sites, stations, pointTotal, gapSummary] = await Promise.all([
    queryAsAnalyzeRole<RoleRow>(
      pool,
      `SELECT r.point_role, r.display_name, r.description, r.measurement, r.typical_unit,
              r.is_setpoint, r.is_command, r.is_status,
              (SELECT count(*) FROM bas_points p WHERE p.point_role = r.point_role)::text AS points
         FROM bas_point_roles r
        ORDER BY r.point_role`,
      [],
    ),
    queryAsAnalyzeRole<SiteRow>(
      pool,
      `SELECT s.site_id::text, s.name AS site, pr.name AS project, o.name AS org, s.timezone,
              (SELECT count(*) FROM bas_stations st WHERE st.site_id = s.site_id)::text AS stations,
              (SELECT count(*) FROM bas_points p JOIN bas_stations st ON st.station_id = p.station_id
                WHERE st.site_id = s.site_id)::text AS points
         FROM bas_sites s
         JOIN bas_projects pr ON pr.project_id = s.project_id
         JOIN bas_orgs o ON o.org_id = s.org_id
        ORDER BY o.name, pr.name, s.name`,
      [],
    ),
    queryAsAnalyzeRole<StationRow>(
      pool,
      `SELECT st.station_id::text, COALESCE(st.display_name, st.niagara_station_name) AS station,
              s.name AS site, st.is_active,
              (SELECT count(*) FROM bas_points p WHERE p.station_id = st.station_id)::text AS points,
              (SELECT count(*) FROM bas_points p WHERE p.station_id = st.station_id AND p.is_active)::text AS active_points
         FROM bas_stations st
         JOIN bas_sites s ON s.site_id = st.site_id
        ORDER BY s.name, station`,
      [],
    ),
    queryAsAnalyzeRole<{ n: string }>(pool, `SELECT count(*)::text AS n FROM bas_points`, []),
    queryAsAnalyzeRole<GapSummaryRow>(
      pool,
      `SELECT count(*)::text AS n,
              (SUM(EXTRACT(EPOCH FROM (gap_end - gap_start))) / 3600.0)::text AS hours,
              min(gap_start) AS earliest, max(gap_end) AS latest
         FROM bas_data_gaps`,
      [],
    ),
  ]);

  const pointCount = Number(pointTotal[0]?.n ?? 0);
  const points =
    pointCount <= LIST_POINTS_UP_TO
      ? await queryAsAnalyzeRole<PointRow>(
          pool,
          `SELECT p.point_id::text,
                  COALESCE(p.label, p.display_name, p.niagara_history_name) AS name,
                  p.niagara_history_name AS niagara_name,
                  COALESCE(st.display_name, st.niagara_station_name) AS station,
                  s.name AS site, p.point_role, p.unit, p.data_type, p.is_active, p.inactive_reason,
                  COALESCE(c.held_count, 0)::text AS readings,
                  NULL::timestamptz AS first_ts,
                  c.last_record_ts AS last_ts
             FROM bas_points p
             JOIN bas_stations st ON st.station_id = p.station_id
             JOIN bas_sites s ON s.site_id = st.site_id
             LEFT JOIN bas_sync_checkpoints c ON c.point_id = p.point_id
            ORDER BY s.name, station, name, p.point_id`,
          [],
        )
      : [];

  const lines: string[] = [];

  lines.push("## Objects (from bas_v_data_dictionary) with live row counts");
  lines.push("");
  for (const [name, entry] of objects) {
    const n = countOf.get(name);
    lines.push(`### ${name} (${entry.type}${n !== undefined ? `, ${n} rows` : ""})`);
    if (entry.description) lines.push(entry.description);
    for (const col of entry.columns) {
      const nullable = col.is_nullable ? "" : " NOT NULL";
      const desc = col.column_description ? ` -- ${col.column_description}` : "";
      lines.push(`- ${col.column_name}: ${col.data_type}${nullable}${desc}`);
    }
    lines.push("");
  }

  lines.push("## Point roles in use (bas_point_roles, with how many points carry each)");
  lines.push("");
  if (roles.length === 0) {
    lines.push("(no roles defined - every point is unclassified, so nothing can be selected by what it measures)");
  }
  for (const r of roles) {
    const flags = [r.is_setpoint && "setpoint", r.is_command && "command", r.is_status && "status"]
      .filter(Boolean)
      .join(", ");
    lines.push(
      `- ${r.point_role} (${r.points} points${flags ? `, ${flags}` : ""}): ${r.display_name}` +
        `${r.typical_unit ? `, typically ${r.typical_unit}` : ""} - ${r.description}`,
    );
  }
  lines.push("");

  lines.push("## Sites, stations and points");
  lines.push("");
  lines.push("<data>");
  for (const s of sites) {
    lines.push(
      `site_id=${s.site_id} "${s.site}" (project "${s.project}", org "${s.org}", timezone ${s.timezone}, ${s.stations} stations, ${s.points} points)`,
    );
  }
  for (const st of stations) {
    lines.push(
      `station_id=${st.station_id} "${st.station}" at site "${st.site}" ${st.is_active ? "" : "(INACTIVE) "}- ${st.active_points} of ${st.points} points collected`,
    );
  }
  lines.push("</data>");
  lines.push("");

  const gap = gapSummary[0];
  lines.push(
    `## Recorded data gaps: ${gap?.n ?? "0"} gaps` +
      (gap?.hours ? `, ${Number(gap.hours).toFixed(1)} hours in total` : "") +
      (gap?.earliest && gap?.latest
        ? `, between ${gap.earliest.toISOString()} and ${gap.latest.toISOString()}`
        : ""),
  );
  lines.push("A gap means the platform was not watching; it never means the equipment was off.");
  lines.push("");

  if (points.length > 0) {
    lines.push(`## Points (${points.length}; point_id, name, Niagara history name, station, site, role, unit, type, collected, readings held, last record)`);
    lines.push("");
    lines.push("<data>");
    for (const p of points) {
      lines.push(
        `point_id=${p.point_id} | "${p.name}" | ${p.niagara_name} | ${p.station} | ${p.site} | ` +
          `role=${p.point_role ?? "NONE (unclassified)"} | unit=${describeUnit(p.unit)} | ${p.data_type} | ` +
          `${p.is_active ? "collected" : `NOT COLLECTED (${p.inactive_reason ?? "no reason recorded"})`} | ` +
          `${p.readings} readings | last ${p.last_ts ? p.last_ts.toISOString() : "never"}`,
      );
    }
    lines.push("</data>");
  } else {
    lines.push(
      `## Points: ${pointCount} in total - too many to list. Select them with SQL against bas_points.`,
    );
  }

  return {
    text: lines.join("\n"),
    objectCount: objects.size,
    pointCount,
    builtAt: new Date().toISOString(),
  };
}
