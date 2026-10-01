import { Prisma } from "@/lib/generated/prisma/client";
import type { Viewer } from "@/lib/authz";
import { prisma } from "@/lib/db";
import { writeAuditEvent } from "@/lib/audit";
import { BAS_MODULE_KEY } from "./constants";
import { BasError } from "./errors";
import {
  CredentialError,
  credentialKeyState,
  currentKeyVersion,
  encryptPassword,
} from "./credentials";
import { basSiteScope } from "./service";
import { resetSchemaContextCache } from "./analyze/schema-context";
import {
  suggestClassification,
  type EquipmentFacts,
  type RoleFacts,
} from "./suggestions";
import type {
  BulkClassifyInput,
  CreateBuildingInput,
  CreateEquipmentInput,
  CreateProjectInput,
  CreateStationInput,
  SetCredentialInput,
  UpdateBuildingInput,
  UpdateEquipmentInput,
  UpdateProjectInput,
  UpdateStationInput,
  UpdatePointEquipmentInput,
  UpdatePointLabelInput,
  UpdatePointRoleInput,
  UpdatePointVisibilityInput,
} from "@/lib/validation/bas-settings";
import {
  COLLECTING_WITHIN_HOURS,
  NO_SETTINGS_FILTERS,
  isInactiveReason,
  settingsFiltersActive,
} from "./types";
import type {
  BasSettingsFilters,
  BasSettingsTree,
  BasVocabularies,
  BuildingEquipmentList,
  BulkClassifyResult,
  Completeness,
  PointSuggestion,
  SettingsBuilding,
  SettingsEquipment,
  SettingsPoint,
  SettingsProject,
  SettingsStation,
  StationPointsList,
  StationReach,
} from "./types";
import { toHorizonState } from "./types";

/**
 * The Settings tab's data: organisation -> project -> building -> station.
 *
 * Read-only. B7.3 and B7.4 add the forms; nothing here writes, and nothing here
 * reads bas_station_credentials beyond whether a row exists. The ciphertext,
 * the username and the key version are not selected at all - not filtered out
 * downstream, not selected. A column that is never read cannot be leaked by a
 * later refactor of the serialiser.
 *
 * Employee-parameterised from the first line, like the rest of this module, and
 * it calls the SAME `basSiteScope` that Collection Health and Point Explorer
 * call rather than defining its own. When `bas_site_grant` arrives, one function
 * changes and this screen scopes with everything else.
 *
 * TWO QUERIES, NOT ONE, and the reason is what the tree has to be able to show.
 *
 *   - Query A walks projects -> buildings. LEFT JOIN, so a project with no
 *     buildings and a building with no stations both appear. Someone who has
 *     just created a project needs to see it, and a station-rooted query cannot
 *     produce a row for a building that has none.
 *   - Query B walks stations upward. Also LEFT JOIN, so a station cannot be
 *     dropped by a missing parent row.
 *
 * A single joined query would have to pick one of those two shapes and would
 * silently lose the other end.
 */

/** One row of the project -> building walk. `site_*` is null for an empty project. */
interface HierarchyRow {
  project_id: bigint;
  project_name: string;
  org_name: string;
  site_id: bigint | null;
  site_name: string | null;
  timezone: string | null;
  address: string | null;
}

interface StationRow {
  station_id: bigint;
  site_id: bigint | null;
  niagara_station_name: string;
  display_name: string | null;
  connection_mode: string;
  base_url: string | null;
  tls_sha256: string | null;
  parent_station_id: bigint | null;
  parent_station_name: string | null;
  is_active: boolean;
  last_seen_at: Date | null;
  active_points: bigint;
  total_points: bigint;
  /** Username and timestamp only. The ciphertext column is never selected. */
  cred_username: string | null;
  cred_updated_at: Date | null;
  last_run_at: Date | null;
  last_run_status: string | null;
  newest_record_at: Date | null;
  ever_collected: boolean;
}

/**
 * `via_parent` with nothing to be a parent is the "discovered, unassigned"
 * state: a station whose history is said to arrive through another station,
 * without saying which one.
 *
 * Derived here rather than stored, because it is not a fourth mode - it is the
 * absence of an answer, and storing it would create two ways to say the same
 * thing. `base_url` is deliberately NOT part of this test: a discovered station
 * inherits the central station's URL from the collector's config, so a set
 * base_url says nothing about whether anyone has configured this row.
 */
function reachOf(row: StationRow): StationReach {
  if (row.connection_mode === "direct") return "direct";
  return row.parent_station_name === null ? "unconfigured" : "via_parent";
}

function toStation(row: StationRow): SettingsStation {
  return {
    stationId: row.station_id.toString(),
    niagaraStationName: row.niagara_station_name,
    displayName: row.display_name,
    reach: reachOf(row),
    baseUrl: row.base_url,
    parentStationName: row.parent_station_name,
    parentStationId: row.parent_station_id?.toString() ?? null,
    tlsSha256: row.tls_sha256,
    isActive: row.is_active,
    activePoints: Number(row.active_points),
    totalPoints: Number(row.total_points),
    lastSeenAt: row.last_seen_at?.toISOString() ?? null,
    hasCredential: row.cred_updated_at !== null,
    // The username and when it was last set. No branch of this function can
    // reach the ciphertext: it is not in StationRow and not in the SELECT.
    credential:
      row.cred_updated_at === null
        ? null
        : {
            username: row.cred_username ?? "",
            passwordSet: true,
            passwordUpdatedAt: row.cred_updated_at.toISOString(),
          },
    activity: {
      lastRunAt: row.last_run_at?.toISOString() ?? null,
      lastRunStatus: row.last_run_status,
      everCollected: row.ever_collected,
      newestRecordAt: row.newest_record_at?.toISOString() ?? null,
    },
  };
}

/**
 * The filter, as SQL (B7.6).
 *
 * FILTERED IN THE QUERY, not in the browser. With one project the two are
 * indistinguishable; at ten they are not, and a screen that ships every station
 * to the client and hides most of them is a screen that got slower for no
 * reason and leaked rows into a response that claimed to exclude them.
 *
 * Two predicates, because they are applied at different levels. `stationWhere`
 * decides which STATIONS survive; `searchWhere` also lets a project or building
 * surface on its own name when no station filter is narrowing things.
 */
function stationPredicate(f: BasSettingsFilters): Prisma.Sql {
  const clauses: Prisma.Sql[] = [];

  const q = f.q.trim();
  if (q.length > 0) {
    // One term, matched against everything a person might type. Escaped for
    // LIKE so a name containing % or _ searches for itself rather than
    // becoming a wildcard.
    const like = `%${q.replace(/([%_\\])/g, "\\$1")}%`;
    // The EXISTS is B8.4: a station surfaces when one of ITS POINTS matches
    // by any of the point's three names - the label a person typed, the name
    // Niagara reports, or the oBIX key pasted straight out of Workbench. The
    // ugly name keeps its diagnostic value without being on a browsing
    // screen. The Points list under the station then narrows to the same
    // term, so the match is visible rather than merely implied.
    clauses.push(Prisma.sql`(
         st.display_name          ILIKE ${like} ESCAPE '\\'
      OR st.niagara_station_name  ILIKE ${like} ESCAPE '\\'
      OR st.base_url              ILIKE ${like} ESCAPE '\\'
      OR s.name                   ILIKE ${like} ESCAPE '\\'
      OR p.name                   ILIKE ${like} ESCAPE '\\'
      OR EXISTS (
           SELECT 1 FROM bas_points pt
            WHERE pt.station_id = st.station_id
              AND (   pt.label                ILIKE ${like} ESCAPE '\\'
                   OR pt.display_name         ILIKE ${like} ESCAPE '\\'
                   OR pt.niagara_history_name ILIKE ${like} ESCAPE '\\')
         )
    )`);
  }

  if (f.mode !== null) {
    // `unconfigured` is not a stored value - it is via_parent with nothing to
    // be a parent, which the add_bas_projects migration deliberately allows so
    // that a JACE linked in Workbench and never labelled here can exist as a
    // row rather than being refused. Splitting it out here is what turns that
    // tolerated state into a work queue somebody can actually pull from.
    clauses.push(
      f.mode === "unconfigured"
        ? Prisma.sql`(st.connection_mode = 'via_parent' AND st.parent_station_id IS NULL)`
        : f.mode === "via_parent"
          ? Prisma.sql`(st.connection_mode = 'via_parent' AND st.parent_station_id IS NOT NULL)`
          : Prisma.sql`st.connection_mode = ${f.mode}`,
    );
  }

  if (f.credential !== null) {
    clauses.push(
      f.credential === "set"
        ? Prisma.sql`cred.station_id IS NOT NULL`
        : Prisma.sql`cred.station_id IS NULL`,
    );
  }

  if (f.state !== null) {
    // Bucketed on the newest RECORD, not the newest run: a run that completed
    // successfully having collected nothing is not a station that is
    // collecting, and that distinction is the whole reason this filter is
    // worth having.
    const newest = Prisma.sql`(
      SELECT max(ck.last_record_ts)
        FROM bas_points pt2
        LEFT JOIN bas_sync_checkpoints ck ON ck.point_id = pt2.point_id
       WHERE pt2.station_id = st.station_id
    )`;
    const cutoff = Prisma.sql`now() - ${`${COLLECTING_WITHIN_HOURS} hours`}::interval`;

    if (f.state === "never") {
      clauses.push(Prisma.sql`${newest} IS NULL`);
    } else if (f.state === "collecting") {
      clauses.push(Prisma.sql`${newest} >= ${cutoff}`);
    } else {
      clauses.push(Prisma.sql`(${newest} IS NOT NULL AND ${newest} < ${cutoff})`);
    }
  }

  if (clauses.length === 0) return Prisma.sql`TRUE`;
  return clauses.reduce((all, one) => Prisma.sql`${all} AND ${one}`);
}

/**
 * Whether a filter narrows STATIONS specifically.
 *
 * When one does, a building with no surviving station is not interesting and a
 * project with no surviving building is noise. Search on its own is different:
 * typing a project name should show that project even if it holds nothing yet,
 * because "did my new project save?" is a question this screen has to answer.
 */
function narrowsStations(f: BasSettingsFilters): boolean {
  return f.mode !== null || f.state !== null || f.credential !== null;
}

/**
 * The entitlement as SQL. `null` is everyone today; an employee entitled to no
 * sites gets FALSE rather than an empty fragment that would show them all.
 * Shared by the tree and the points list so the two cannot scope differently.
 */
function entitlementSql(entitled: bigint[] | null, column: Prisma.Sql): Prisma.Sql {
  if (entitled === null) return Prisma.sql`TRUE`;
  if (entitled.length === 0) return Prisma.sql`FALSE`;
  return Prisma.sql`${column} IN (${Prisma.join(entitled)})`;
}

export async function getBasSettingsTree(
  viewer: Viewer,
  filters: BasSettingsFilters = NO_SETTINGS_FILTERS,
): Promise<BasSettingsTree> {
  const { entitled } = await basSiteScope(viewer);
  const active = settingsFiltersActive(filters);
  const where = stationPredicate(filters);
  const stationsOnly = narrowsStations(filters);
  const q = filters.q.trim();
  const like = `%${q.replace(/([%_\\])/g, "\\$1")}%`;

  // The entitlement, applied to both queries.
  const siteScope = (column: Prisma.Sql): Prisma.Sql =>
    entitlementSql(entitled, column);

  const [orgs, hierarchy, stations, stationTotal, stationMatched] =
    await Promise.all([
    prisma.basOrg.findMany({
      select: { orgId: true, name: true },
      orderBy: { name: "asc" },
    }),

    prisma.$queryRaw<HierarchyRow[]>`
      SELECT
        p.project_id,
        p.name        AS project_name,
        o.name        AS org_name,
        s.site_id,
        s.name        AS site_name,
        s.timezone,
        s.address
      FROM bas_projects p
      JOIN bas_orgs o ON o.org_id = p.org_id
      -- LEFT: a project with no buildings is a real thing to look at, not a
      -- row to drop. The entitlement rides on the JOIN rather than the WHERE
      -- for the same reason - moving it to WHERE would turn this back into an
      -- inner join and hide empty projects.
      LEFT JOIN bas_sites s
        ON s.project_id = p.project_id
       AND ${siteScope(Prisma.sql`s.site_id`)}
       -- A building survives the join if one of its stations survives the
       -- filter, or - when no STATION filter is narrowing - if its own name or
       -- its project's name matches the search. The s and p referenced inside
       -- the EXISTS are the OUTER aliases, which is what lets a station match
       -- on the name of the building it sits in.
       --
       -- No backticks in these comments: this whole query is a TypeScript
       -- template literal and a backtick ends it.
       AND (
         ${active ? Prisma.sql`FALSE` : Prisma.sql`TRUE`}
         OR EXISTS (
           SELECT 1
             FROM bas_stations st
             LEFT JOIN bas_station_credentials cred ON cred.station_id = st.station_id
            WHERE st.site_id = s.site_id AND ${where}
         )
         OR (
           ${stationsOnly ? Prisma.sql`FALSE` : Prisma.sql`TRUE`}
           AND ${
             q.length === 0
               ? Prisma.sql`FALSE`
               : Prisma.sql`(s.name ILIKE ${like} ESCAPE '' OR p.name ILIKE ${like} ESCAPE '')`
           }
         )
       )
      -- A project survives if a building survived the join above - which the
      -- LEFT JOIN reports as a non-null s.site_id - or if its own name matched.
      -- A project with no buildings at all yields one row with s.site_id NULL,
      -- so it is kept only when nothing is filtering or its name matched.
      WHERE ${active ? Prisma.sql`FALSE` : Prisma.sql`TRUE`}
         OR s.site_id IS NOT NULL
         OR (
           ${stationsOnly ? Prisma.sql`FALSE` : Prisma.sql`TRUE`}
           AND ${
             q.length === 0
               ? Prisma.sql`FALSE`
               : Prisma.sql`p.name ILIKE ${like} ESCAPE ''`
           }
         )
      ORDER BY o.name, p.name, s.name`,

    prisma.$queryRaw<StationRow[]>`
      SELECT
        st.station_id,
        st.site_id,
        st.niagara_station_name,
        st.display_name,
        st.connection_mode,
        st.base_url,
        st.tls_sha256,
        st.parent_station_id,
        parent.niagara_station_name AS parent_station_name,
        st.is_active,
        st.last_seen_at,
        -- Counted by correlated subqueries on bas_points ALONE, not through the
        -- LEFT JOIN below (B8.2). The Points list under this row compares what
        -- it rendered against a joinless count, and the number on the row has
        -- to be that same kind of number - right whether or not anyone expands
        -- the station, and not inflatable by a join that stops being 1:1.
        (SELECT count(*) FROM bas_points x
          WHERE x.station_id = st.station_id AND x.is_active) AS active_points,
        (SELECT count(*) FROM bas_points x
          WHERE x.station_id = st.station_id)                 AS total_points,
        -- The username and when it moved. password_ciphertext and key_version
        -- are NOT in this list and must never be: a column that is never
        -- selected cannot be leaked by a later change to the serialiser.
        cred.username                                  AS cred_username,
        cred.updated_at                                AS cred_updated_at,
        -- Is it actually collecting? Answered from what the collector already
        -- wrote, so it is true from Azure as well as from the building network.
        -- This is what stands in for a "test connection" button, which could
        -- only ever work from a machine on the building network.
        run.started_at                                 AS last_run_at,
        run.status                                     AS last_run_status,
        max(ck.last_record_ts)                         AS newest_record_at,
        -- Has ANY run against this station ever succeeded? This is what tells
        -- "registered, awaiting its login" (amber) from "was collecting, lost
        -- its login" (red) - see describeLogin. A correlated subquery on the
        -- grouped key, so it needs no GROUP BY entry of its own.
        EXISTS (
          SELECT 1 FROM bas_ingest_runs r
           WHERE r.station_id = st.station_id
             AND r.status IN ('ok', 'partial')
        )                                              AS ever_collected
      FROM bas_stations st
      -- Joined so the search can match a station by its BUILDING or PROJECT
      -- name. LEFT, so a station whose building is missing is still returned
      -- and lands in unassignedStations rather than disappearing.
      LEFT JOIN bas_sites s ON s.site_id = st.site_id
      LEFT JOIN bas_projects p ON p.project_id = s.project_id
      LEFT JOIN bas_stations parent ON parent.station_id = st.parent_station_id
      LEFT JOIN bas_points pt ON pt.station_id = st.station_id
      LEFT JOIN bas_sync_checkpoints ck ON ck.point_id = pt.point_id
      LEFT JOIN bas_station_credentials cred ON cred.station_id = st.station_id
      LEFT JOIN LATERAL (
        SELECT r.started_at, r.status
          FROM bas_ingest_runs r
         WHERE r.station_id = st.station_id
         ORDER BY r.started_at DESC
         LIMIT 1
      ) run ON TRUE
      -- OR site_id IS NULL matches what the ingest-run queries already do: a
      -- station attached to no building is not "somebody else's building", and
      -- filtering it out would hide the row this screen exists to surface.
      WHERE (${siteScope(Prisma.sql`st.site_id`)} OR st.site_id IS NULL)
        AND ${where}
      GROUP BY st.station_id, parent.niagara_station_name,
               cred.username, cred.updated_at, run.started_at, run.status
      ORDER BY st.niagara_station_name`,

    // Counted separately and deliberately NOT through the tree's joins or its
    // assembly, so it cannot agree with the tree by construction.
    // See stationsAccountedFor.
    prisma.$queryRaw<Array<{ n: bigint }>>`
      SELECT count(*) AS n
      FROM bas_stations st
      WHERE ${siteScope(Prisma.sql`st.site_id`)} OR st.site_id IS NULL`,

    // The same, WITH the filter applied. This is what `rendered` is compared
    // against, and comparing against the unfiltered count instead is exactly
    // the false alarm B7.6 exists to avoid.
    prisma.$queryRaw<Array<{ n: bigint }>>`
      SELECT count(*) AS n
      FROM bas_stations st
      LEFT JOIN bas_sites s ON s.site_id = st.site_id
      LEFT JOIN bas_projects p ON p.project_id = s.project_id
      LEFT JOIN bas_station_credentials cred ON cred.station_id = st.station_id
      WHERE (${siteScope(Prisma.sql`st.site_id`)} OR st.site_id IS NULL)
        AND ${where}`,
  ]);

  const stationsBySite = new Map<string, SettingsStation[]>();
  const unassignedStations: SettingsStation[] = [];

  for (const row of stations) {
    const station = toStation(row);
    if (row.site_id === null) {
      unassignedStations.push(station);
      continue;
    }
    const key = row.site_id.toString();
    const bucket = stationsBySite.get(key);
    if (bucket === undefined) stationsBySite.set(key, [station]);
    else bucket.push(station);
  }

  const projects: SettingsProject[] = [];
  const byProject = new Map<string, SettingsProject>();
  const placedSites = new Set<string>();
  const siteNames = new Map<string, string>();

  for (const row of hierarchy) {
    const projectKey = row.project_id.toString();
    let project = byProject.get(projectKey);

    if (project === undefined) {
      project = {
        projectId: projectKey,
        name: row.project_name,
        orgName: row.org_name,
        buildings: [],
      };
      byProject.set(projectKey, project);
      projects.push(project);
    }

    if (row.site_id === null) continue;

    const siteKey = row.site_id.toString();
    placedSites.add(siteKey);
    siteNames.set(siteKey, row.site_name ?? "");

    const building: SettingsBuilding = {
      siteId: siteKey,
      name: row.site_name ?? "",
      timezone: row.timezone ?? "",
      address: row.address,
      stations: stationsBySite.get(siteKey) ?? [],
    };
    project.buildings.push(building);
  }

  // A station whose building exists but whose building did not come back from
  // query A. Impossible while project_id is NOT NULL, and counted anyway - this
  // is the other half of the guarantee that no station is silently dropped.
  for (const [siteKey, bucket] of stationsBySite) {
    if (!placedSites.has(siteKey)) unassignedStations.push(...bucket);
  }

  const rendered =
    projects.reduce(
      (total, project) =>
        total +
        project.buildings.reduce(
          (sum, building) => sum + building.stations.length,
          0,
        ),
      0,
    ) + unassignedStations.length;

  const allStations = stations.map((row) => ({
    stationId: row.station_id.toString(),
    niagaraStationName: row.niagara_station_name,
    siteName:
      row.site_id === null
        ? "unassigned"
        : (siteNames.get(row.site_id.toString()) ?? "unknown building"),
  }));

  return {
    orgs: orgs.map((o) => ({ orgId: o.orgId.toString(), name: o.name })),
    credentialStorage: basCredentialAvailability(),
    allStations,
    projects,
    unassignedStations,
    stationsAccountedFor: {
      rendered,
      matched: Number(stationMatched[0]?.n ?? 0),
      inDatabase: Number(stationTotal[0]?.n ?? 0),
      filtered: active,
    },
  };
}

// ---------------------------------------------------------------------------
// Points (B8.2) - one station's points. Read-only here; the two editable
// fields (B8.3 visible, B8.4 label) have their own functions below.
// ---------------------------------------------------------------------------

interface PointListRow {
  point_id: bigint;
  label: string | null;
  niagara_history_name: string;
  /** bas_points.display_name: NIAGARA's name. See SettingsPoint. */
  display_name: string | null;
  point_role: string | null;
  role_name: string | null;
  equipment_id: bigint | null;
  equipment_name: string | null;
  unit: string | null;
  is_active: boolean;
  inactive_reason: string | null;
  is_visible: boolean;
  completeness: string | null;
  last_record_ts: Date | null;
  /** From bas_v_collection_health. NULL when the station has no view row. */
  horizon_state: string | null;
  horizon_hours: number | null;
  current_horizon_hours: number | null;
  station_count: number | null;
  capacity: number | null;
}

const COMPLETENESS_VALUES: readonly Completeness[] = [
  "unknown",
  "complete",
  "backfilling",
  "incomplete",
];

function toPoint(row: PointListRow, suggestion: PointSuggestion | null): SettingsPoint {
  return {
    pointId: row.point_id.toString(),
    label: row.label,
    niagaraHistoryName: row.niagara_history_name,
    niagaraDisplayName: row.display_name,
    pointRole: row.point_role,
    roleName: row.role_name,
    equipmentId: row.equipment_id?.toString() ?? null,
    equipmentName: row.equipment_name,
    unit: row.unit,
    suggestion,
    collected: row.is_active,
    // Closed by bas_points_inactive_reason_check; the guard is for the type.
    inactiveReason: isInactiveReason(row.inactive_reason) ? row.inactive_reason : null,
    // The CHECK on bas_sync_checkpoints.completeness makes this a closed set;
    // the guard is for the type, not the data.
    completeness:
      row.completeness !== null &&
      (COMPLETENESS_VALUES as readonly string[]).includes(row.completeness)
        ? (row.completeness as Completeness)
        : null,
    // The view's three states, never re-derived here. A NULL state is a point
    // with no view row - its station is attached to no building - and reads
    // unknown, which is the honest word for a horizon nobody has computed.
    horizon: {
      state: toHorizonState(row.horizon_state),
      hours: row.horizon_hours,
      currentHours: row.current_horizon_hours,
      stationCount: row.station_count,
      capacity: row.capacity,
    },
    lastRecordAt: row.last_record_ts?.toISOString() ?? null,
    visible: row.is_visible,
  };
}

/**
 * Every point on one station, with the guard that proves it is every point.
 *
 * EVERYTHING IS SHOWN. A point that is not collected is not filtered out - it
 * is exactly the row somebody needs to see, and hiding inactive points is how
 * the _cfg0 question went unnoticed for weeks. Nothing filters on is_visible
 * either: a hidden point has to be somewhere it can be shown again. And
 * nothing here searches - B8.4's search narrows the rows in the browser,
 * after this has returned every one of them, so the counting guard below
 * stays a statement about the database and not about a filter.
 *
 * Every join is LEFT. A point with no equipment, no role or no checkpoint row
 * is a point, and a query that lost it would be lying about the station. The
 * count beside the rows is taken from bas_points alone, with no joins, so the
 * two cannot agree by construction - if a join ever drops a row, `rendered`
 * falls short of `inDatabase` and the screen says so.
 *
 * Scoped the way the tree is: the station must be in the viewer's entitlement
 * (or attached to no building, like the tree's unassigned bucket), and one that
 * is not reads as not found. Same conflation as every other 404 in this module.
 */
export async function getStationPoints(
  viewer: Viewer,
  stationIdText: string,
): Promise<StationPointsList> {
  // A malformed id is not a station. BigInt() would throw on it and turn a bad
  // URL into a 500.
  if (!/^\d{1,18}$/.test(stationIdText)) {
    throw new BasError("station_not_found", "That station does not exist.");
  }
  const stationId = BigInt(stationIdText);
  const { entitled } = await basSiteScope(viewer);

  const station = await prisma.$queryRaw<Array<{ station_id: bigint; site_id: bigint | null }>>`
    SELECT st.station_id, st.site_id
      FROM bas_stations st
     WHERE st.station_id = ${stationId}
       AND (${entitlementSql(entitled, Prisma.sql`st.site_id`)} OR st.site_id IS NULL)`;
  const found = station[0];
  if (found === undefined) {
    throw new BasError("station_not_found", "That station does not exist.");
  }
  const siteId = found.site_id;

  const [rows, total, roleFacts, buildingEquipment] = await Promise.all([
    prisma.$queryRaw<PointListRow[]>`
      SELECT
        p.point_id,
        p.label,
        p.niagara_history_name,
        p.display_name,
        p.point_role,
        pr.display_name AS role_name,
        p.equipment_id,
        e.name          AS equipment_name,
        p.unit,
        p.is_active,
        p.inactive_reason,
        p.is_visible,
        c.completeness,
        c.last_record_ts,
        h.horizon_state,
        (h.horizon_s / 3600.0)::float8          AS horizon_hours,
        (h.current_full_span_s / 3600.0)::float8 AS current_horizon_hours,
        c.station_count,
        p.capacity
      FROM bas_points p
      -- LEFT, all four. An unclassified point has no role row, an unassigned
      -- one has no equipment row, one the collector has never passed has no
      -- checkpoint row, and one on a station attached to no building has no
      -- view row. Each of those is a point this list exists to show.
      LEFT JOIN bas_point_roles      pr ON pr.point_role   = p.point_role
      LEFT JOIN bas_equipment        e  ON e.equipment_id  = p.equipment_id
      LEFT JOIN bas_sync_checkpoints c  ON c.point_id      = p.point_id
      -- The horizon in its three states, from the one place that decides them.
      -- Cheap: the view reads checkpoints, never bas_readings.
      LEFT JOIN bas_v_collection_health h ON h.point_id    = p.point_id
      WHERE p.station_id = ${stationId}
      -- By the key, which is stable and unique per station. Labels are mostly
      -- NULL today and a sort that switched columns as they filled in would
      -- reorder the list under the person naming it.
      ORDER BY p.niagara_history_name`,

    // Counted with NO joins, deliberately, so it cannot agree with the rows by
    // construction. See PointCounts.
    prisma.$queryRaw<Array<{ n: bigint }>>`
      SELECT count(*) AS n FROM bas_points WHERE station_id = ${stationId}`,

    // For the suggestions (B8.5): the vocabulary as THIS database holds it,
    // so a pattern can only suggest a role that can be assigned here, and
    // the building's equipment, so a suggested "VAV-3" is matched to the
    // existing row or offered as new. READ ONLY - nothing in this function
    // writes, and the test proves a read changes no row.
    prisma.$queryRaw<Array<{ point_role: string; display_name: string; typical_unit: string | null }>>`
      SELECT point_role, display_name, typical_unit FROM bas_point_roles`,
    siteId === null
      ? Promise.resolve([] as Array<{ equipment_id: bigint; name: string }>)
      : prisma.$queryRaw<Array<{ equipment_id: bigint; name: string }>>`
          SELECT equipment_id, name FROM bas_equipment WHERE site_id = ${siteId}`,
  ]);

  const roles = new Map<string, RoleFacts>(
    roleFacts.map((r) => [
      r.point_role,
      { pointRole: r.point_role, displayName: r.display_name, typicalUnit: r.typical_unit },
    ]),
  );
  const equipmentFacts: EquipmentFacts[] = buildingEquipment.map((e) => ({
    equipmentId: e.equipment_id.toString(),
    name: e.name,
  }));

  return {
    stationId: stationId.toString(),
    siteId: siteId?.toString() ?? null,
    points: rows.map((row) =>
      toPoint(
        row,
        suggestClassification(
          {
            niagaraHistoryName: row.niagara_history_name,
            niagaraDisplayName: row.display_name,
            unit: row.unit,
            pointRole: row.point_role,
            equipmentId: row.equipment_id?.toString() ?? null,
            collected: row.is_active,
          },
          roles,
          equipmentFacts,
        ),
      ),
    ),
    pointsAccountedFor: {
      rendered: rows.length,
      inDatabase: Number(total[0]?.n ?? 0),
    },
  };
}

/**
 * Show or hide one point on the browsing screens (B8.3).
 *
 * THE ONE THING THIS MUST NOT DO is touch `is_active`. Hiding is cosmetic and
 * reversible; deactivating stops collection and the station overwrites what
 * was not collected. The schema this accepts has no `isActive` field, the
 * update below names `isVisible` alone, and the audit row records that the
 * point was still collected at the time, so a later reader cannot mistake
 * "hid it" for "stopped collecting it".
 *
 * Scoped like getStationPoints: the point's station must be in the viewer's
 * entitlement or attached to no building, and one that is not reads as not
 * found. `changed: false` when the row already had that value, with no audit
 * row - a checkbox clicked twice is not two changes.
 */
export async function setBasPointVisibility(
  viewer: Viewer,
  pointIdText: string,
  input: UpdatePointVisibilityInput,
): Promise<{ changed: boolean }> {
  const { pointId, point } = await loadScopedPoint(viewer, pointIdText);

  if (point.is_visible === input.visible) return { changed: false };

  await prisma.$transaction(async (tx) => {
    await tx.basPoint.update({
      where: { pointId },
      data: { isVisible: input.visible },
    });

    await writeAuditEvent(tx, {
      action: "bas.point_visibility_changed",
      actorEmployeeId: viewer.id,
      moduleKey: BAS_MODULE_KEY,
      metadata: {
        pointId: pointIdText,
        stationId: point.station_id.toString(),
        niagaraHistoryName: point.niagara_history_name,
        label: point.label,
        visible: input.visible,
        // So the row can never be read as "and stopped collecting it".
        collected: point.is_active,
      },
    });
  });

  return { changed: true };
}

/**
 * Set, change or clear what a person calls one point (B8.4).
 *
 * ONE COLUMN MOVES: `bas_points.label`. Not `niagara_history_name`, which is
 * the oBIX key and goes into the collector's URL verbatim - editing it stops
 * the point collecting, so there is no code path that writes it. Not
 * `display_name`, which is Niagara's and is refreshed by every discover. Not
 * `is_active` or `is_visible`. The update names `label` alone, and the test
 * reads the other four columns before and after.
 *
 * `null` clears the label, and the screens fall back to Niagara's name. A
 * blank string never reaches here - the schema turned it into null - and the
 * CHECK `bas_points_label_not_blank` refuses it if one ever does, so "no
 * label" has exactly one spelling.
 *
 * Scoped like the visibility change. `changed: false` with no audit row when
 * the label is already what was sent. The audit row carries the previous and
 * new label and the point's two Niagara names, so it identifies the point
 * after any later rename.
 */
export async function setBasPointLabel(
  viewer: Viewer,
  pointIdText: string,
  input: UpdatePointLabelInput,
): Promise<{ changed: boolean; label: string | null }> {
  const { pointId, point } = await loadScopedPoint(viewer, pointIdText);

  if (point.label === input.label) return { changed: false, label: point.label };

  await prisma.$transaction(async (tx) => {
    await tx.basPoint.update({
      where: { pointId },
      data: { label: input.label },
    });

    await writeAuditEvent(tx, {
      action: "bas.point_label_changed",
      actorEmployeeId: viewer.id,
      moduleKey: BAS_MODULE_KEY,
      metadata: {
        pointId: pointIdText,
        stationId: point.station_id.toString(),
        niagaraHistoryName: point.niagara_history_name,
        niagaraDisplayName: point.display_name,
        previousLabel: point.label,
        label: input.label,
      },
    });
  });

  return { changed: true, label: input.label };
}

interface ScopedPointRow {
  station_id: bigint;
  niagara_history_name: string;
  /** bas_points.display_name: Niagara's name. */
  display_name: string | null;
  label: string | null;
  is_visible: boolean;
  is_active: boolean;
}

/**
 * One point, if it is the viewer's to change. Shared by the two point
 * mutations so they cannot scope differently.
 *
 * A malformed id is not a point: BigInt() would throw on it and turn a bad
 * URL into a 500. The station must be in the viewer's entitlement or attached
 * to no building, and one that is not reads as not found - the same
 * conflation as every other 404 in this module.
 */
async function loadScopedPoint(
  viewer: Viewer,
  pointIdText: string,
): Promise<{ pointId: bigint; point: ScopedPointRow }> {
  if (!/^\d{1,18}$/.test(pointIdText)) {
    throw new BasError("point_not_found", "That point does not exist.");
  }
  const pointId = BigInt(pointIdText);
  const { entitled } = await basSiteScope(viewer);

  const rows = await prisma.$queryRaw<ScopedPointRow[]>`
    SELECT p.station_id, p.niagara_history_name, p.display_name, p.label,
           p.is_visible, p.is_active
      FROM bas_points p
      JOIN bas_stations st ON st.station_id = p.station_id
     WHERE p.point_id = ${pointId}
       AND (${entitlementSql(entitled, Prisma.sql`st.site_id`)} OR st.site_id IS NULL)`;
  const point = rows[0];
  if (point === undefined) {
    throw new BasError("point_not_found", "That point does not exist.");
  }
  return { pointId, point };
}

// ---------------------------------------------------------------------------
// Roles and equipment (B8.5)
// ---------------------------------------------------------------------------

/**
 * A point as the classification path needs it: its two names and label for
 * the audit row, its station's building for the equipment check, and what it
 * holds now so an unchanged value writes nothing.
 */
interface ClassifiablePoint {
  point_id: bigint;
  station_id: bigint;
  site_id: bigint | null;
  niagara_history_name: string;
  display_name: string | null;
  label: string | null;
  point_role: string | null;
  equipment_id: bigint | null;
  equipment_name: string | null;
}

/**
 * The points of a selection that are the viewer's to change, in one query.
 *
 * Scoped like loadScopedPoint. A selection with an id that is not found - it
 * does not exist, or is on a station outside the viewer's entitlement - is
 * refused WHOLE with `point_not_found`, before anything is written: the
 * selection is one statement ("these are the zone temperatures on VAV-3"),
 * and nine right points plus one wrong one is a wrong statement, not nine
 * right ones. The caller never learns which id was the problem, for the same
 * reason every other not-found here conflates.
 */
async function loadClassifiablePoints(
  viewer: Viewer,
  pointIds: readonly bigint[],
): Promise<ClassifiablePoint[]> {
  const { entitled } = await basSiteScope(viewer);
  const rows = await prisma.$queryRaw<ClassifiablePoint[]>`
    SELECT p.point_id, p.station_id, st.site_id, p.niagara_history_name, p.display_name,
           p.label, p.point_role, p.equipment_id, e.name AS equipment_name
      FROM bas_points p
      JOIN bas_stations st ON st.station_id = p.station_id
      LEFT JOIN bas_equipment e ON e.equipment_id = p.equipment_id
     WHERE p.point_id IN (${Prisma.join([...pointIds])})
       AND (${entitlementSql(entitled, Prisma.sql`st.site_id`)} OR st.site_id IS NULL)`;
  if (rows.length !== pointIds.length) {
    throw new BasError(
      "point_not_found",
      pointIds.length === 1
        ? "That point does not exist."
        : `${pointIds.length - rows.length} of the ${pointIds.length} selected points ` +
          `do not exist or are not available to you. Nothing was changed.`,
    );
  }
  return rows;
}

/** The role must be in the vocabulary as this database holds it. */
async function assertRoleExists(role: string): Promise<void> {
  const found = await prisma.basPointRole.findUnique({
    where: { pointRole: role },
    select: { pointRole: true },
  });
  if (found === null) {
    throw new BasError(
      "role_not_found",
      `${role} is not a role in the vocabulary. The vocabulary is not editable from here.`,
    );
  }
}

interface AssignableEquipment {
  equipment_id: bigint;
  site_id: bigint;
  name: string;
}

/**
 * Equipment that may be assigned to EVERY point in the selection.
 *
 * Three refusals, in order: equipment the viewer cannot see (or that does not
 * exist) is not found; a point whose station has no building cannot take
 * equipment at all; equipment on a different building from any point is
 * refused by name. The pairing views join a point to its setpoint THROUGH the
 * equipment's building, so cross-building equipment would pair a zone on one
 * site with a setpoint on another and the answer would look fine.
 */
async function loadAssignableEquipment(
  viewer: Viewer,
  equipmentId: bigint,
  points: readonly ClassifiablePoint[],
): Promise<AssignableEquipment> {
  const { entitled } = await basSiteScope(viewer);
  const rows = await prisma.$queryRaw<AssignableEquipment[]>`
    SELECT e.equipment_id, e.site_id, e.name
      FROM bas_equipment e
     WHERE e.equipment_id = ${equipmentId}
       AND ${entitlementSql(entitled, Prisma.sql`e.site_id`)}`;
  const equipment = rows[0];
  if (equipment === undefined) {
    throw new BasError("equipment_not_found", "That equipment does not exist.");
  }

  const unassigned = points.filter((p) => p.site_id === null);
  if (unassigned.length > 0) {
    throw new BasError(
      "station_unassigned",
      unassigned.length === points.length
        ? "This station is attached to no building, so its points cannot be given " +
            "equipment. Attach the station to a building first."
        : `${unassigned.length} of the selected points are on a station attached to no ` +
            `building, so they cannot be given equipment. Nothing was changed.`,
    );
  }
  const elsewhere = points.filter((p) => p.site_id !== equipment.site_id);
  if (elsewhere.length > 0) {
    throw new BasError(
      "equipment_other_building",
      elsewhere.length === points.length
        ? `${equipment.name} is in a different building from ${
            points.length === 1 ? "this point" : "these points"
          }. Equipment and its points must share a building.`
        : `${equipment.name} is in a different building from ${elsewhere.length} of the ` +
            `${points.length} selected points. Nothing was changed.`,
    );
  }
  return equipment;
}

interface ClassificationChange {
  /** Absent: leave the role alone. null: clear it. */
  role?: string | null;
  /** Absent: leave the equipment alone. null: detach. */
  equipment?: AssignableEquipment | null;
}

/**
 * THE ONE WRITE PATH for roles and equipment. The single-point functions and
 * the bulk endpoint all come through here, so the audit shape, the
 * "unchanged writes nothing" rule and the building check cannot drift between
 * them.
 *
 * One transaction for the whole selection. A row is updated only where the
 * value differs, and every update is one audit row for that one point - a
 * bulk change is N rows, not one, so any point's own history is complete
 * without knowing it was part of a selection. `viaBulk` and `selectionSize`
 * are on the row so the sentence can say so.
 *
 * The Analyze catalogue caches the vocabulary and point list for five minutes
 * per process; a classification is exactly the kind of change it should see,
 * so the cache is dropped after the commit. The unclassified tile, the pair
 * views and the Projects cards read the tables live and need nothing.
 */
async function applyClassification(
  viewer: Viewer,
  points: readonly ClassifiablePoint[],
  change: ClassificationChange,
  options: { viaBulk: boolean },
): Promise<BulkClassifyResult> {
  let roleChanged = 0;
  let equipmentChanged = 0;
  let unchanged = 0;

  await prisma.$transaction(async (tx) => {
    for (const point of points) {
      let touched = false;
      const identity = {
        pointId: point.point_id.toString(),
        stationId: point.station_id.toString(),
        niagaraHistoryName: point.niagara_history_name,
        niagaraDisplayName: point.display_name,
        label: point.label,
        viaBulk: options.viaBulk,
        selectionSize: points.length,
      };

      if (change.role !== undefined && change.role !== point.point_role) {
        await tx.basPoint.update({
          where: { pointId: point.point_id },
          data: { pointRole: change.role },
        });
        await writeAuditEvent(tx, {
          action: "bas.point_role_changed",
          actorEmployeeId: viewer.id,
          moduleKey: BAS_MODULE_KEY,
          metadata: { ...identity, previousRole: point.point_role, role: change.role },
        });
        roleChanged += 1;
        touched = true;
      }

      if (change.equipment !== undefined) {
        const nextId = change.equipment === null ? null : change.equipment.equipment_id;
        if (nextId !== point.equipment_id) {
          await tx.basPoint.update({
            where: { pointId: point.point_id },
            data: { equipmentId: nextId },
          });
          await writeAuditEvent(tx, {
            action: "bas.point_equipment_changed",
            actorEmployeeId: viewer.id,
            moduleKey: BAS_MODULE_KEY,
            metadata: {
              ...identity,
              previousEquipmentId: point.equipment_id?.toString() ?? null,
              previousEquipmentName: point.equipment_name,
              equipmentId: nextId?.toString() ?? null,
              equipmentName: change.equipment?.name ?? null,
            },
          });
          equipmentChanged += 1;
          touched = true;
        }
      }

      if (!touched) unchanged += 1;
    }
  });

  if (roleChanged + equipmentChanged > 0) resetSchemaContextCache();

  return { points: points.length, roleChanged, equipmentChanged, unchanged };
}

/**
 * Set, change or clear one point's role (B8.5).
 *
 * `null` clears it back to "nobody has looked". The vocabulary's own
 * `unclassified` role ("reviewed, not mappable") is assignable like any
 * other, because that is what the vocabulary says it is for - but it is a
 * role, and a point carrying it leaves the unclassified count.
 */
export async function setBasPointRole(
  viewer: Viewer,
  pointIdText: string,
  input: UpdatePointRoleInput,
): Promise<{ changed: boolean; role: string | null; roleName: string | null }> {
  const point = await loadOneClassifiablePoint(viewer, pointIdText);
  if (input.role !== null) await assertRoleExists(input.role);

  const result = await applyClassification(viewer, [point], { role: input.role }, { viaBulk: false });

  const roleName =
    input.role === null
      ? null
      : ((
          await prisma.basPointRole.findUnique({
            where: { pointRole: input.role },
            select: { displayName: true },
          })
        )?.displayName ?? null);
  return { changed: result.roleChanged > 0, role: input.role, roleName };
}

/** Attach one point to equipment on its building, move it, or detach it (B8.5). */
export async function setBasPointEquipment(
  viewer: Viewer,
  pointIdText: string,
  input: UpdatePointEquipmentInput,
): Promise<{ changed: boolean; equipmentId: string | null; equipmentName: string | null }> {
  const point = await loadOneClassifiablePoint(viewer, pointIdText);
  const equipment =
    input.equipmentId === null
      ? null
      : await loadAssignableEquipment(viewer, BigInt(input.equipmentId), [point]);

  const result = await applyClassification(viewer, [point], { equipment }, { viaBulk: false });
  return {
    changed: result.equipmentChanged > 0,
    equipmentId: equipment?.equipment_id.toString() ?? null,
    equipmentName: equipment?.name ?? null,
  };
}

/**
 * Role and/or equipment on a whole selection, in one transaction (B8.5).
 *
 * ALL OR NOTHING. Every point is loaded and checked - exists, in scope, on a
 * building, on the equipment's building - before the transaction opens, and a
 * single refusal fails the whole request with nothing written. The
 * alternative, applying what can be applied and reporting the rest, leaves a
 * person reconciling a half-applied selection against a list that no longer
 * matches what they chose; a refusal that names the count and changes nothing
 * is the easier state to recover from, because the fix is "adjust the
 * selection and click again". The audit rows are one per point either way, so
 * all-or-nothing costs nothing in traceability.
 *
 * This is also the one endpoint that takes a role AND an equipment together,
 * because accepting a suggestion ("zone_temp on VAV-3") is one human action
 * on both halves and the UI sends it here with a selection of one.
 */
export async function bulkClassifyPoints(
  viewer: Viewer,
  input: BulkClassifyInput,
): Promise<BulkClassifyResult> {
  const pointIds = input.pointIds.map((id) => BigInt(id));
  const points = await loadClassifiablePoints(viewer, pointIds);

  if (input.role !== undefined && input.role !== null) await assertRoleExists(input.role);

  const change: ClassificationChange = {};
  if (input.role !== undefined) change.role = input.role;
  if (input.equipmentId !== undefined) {
    change.equipment =
      input.equipmentId === null
        ? null
        : await loadAssignableEquipment(viewer, BigInt(input.equipmentId), points);
  }

  return applyClassification(viewer, points, change, { viaBulk: true });
}

function parsePointId(pointIdText: string): bigint {
  if (!/^\d{1,18}$/.test(pointIdText)) {
    throw new BasError("point_not_found", "That point does not exist.");
  }
  return BigInt(pointIdText);
}

/** The single-point case of loadClassifiablePoints. */
async function loadOneClassifiablePoint(
  viewer: Viewer,
  pointIdText: string,
): Promise<ClassifiablePoint> {
  const [point] = await loadClassifiablePoints(viewer, [parsePointId(pointIdText)]);
  if (point === undefined) {
    // Unreachable: the loader throws when the count falls short.
    throw new BasError("point_not_found", "That point does not exist.");
  }
  return point;
}

// --- equipment --------------------------------------------------------------

interface EquipmentRow {
  equipment_id: bigint;
  site_id: bigint;
  name: string;
  equip_type: string | null;
  equip_type_name: string | null;
  parent_equipment_id: bigint | null;
  parent_name: string | null;
  notes: string | null;
  point_count: number;
}

function toEquipment(row: EquipmentRow): SettingsEquipment {
  return {
    equipmentId: row.equipment_id.toString(),
    siteId: row.site_id.toString(),
    name: row.name,
    equipType: row.equip_type,
    equipTypeName: row.equip_type_name,
    parentEquipmentId: row.parent_equipment_id?.toString() ?? null,
    parentName: row.parent_name,
    notes: row.notes,
    pointCount: row.point_count,
  };
}

/**
 * Every piece of equipment on one building, for the picker and the
 * equipment panel (B8.5). LEFT JOIN on type and parent - equipment with a
 * type nobody set is still equipment - and the same joinless counting guard
 * the Points list carries.
 */
export async function listBuildingEquipment(
  viewer: Viewer,
  siteIdText: string,
): Promise<BuildingEquipmentList> {
  if (!/^\d{1,18}$/.test(siteIdText)) {
    throw new BasError("building_not_found", "That building does not exist.");
  }
  const siteId = BigInt(siteIdText);
  const { entitled } = await basSiteScope(viewer);

  const site = await prisma.$queryRaw<Array<{ site_id: bigint }>>`
    SELECT s.site_id FROM bas_sites s
     WHERE s.site_id = ${siteId} AND ${entitlementSql(entitled, Prisma.sql`s.site_id`)}`;
  if (site.length === 0) {
    throw new BasError("building_not_found", "That building does not exist.");
  }

  const [rows, total] = await Promise.all([
    prisma.$queryRaw<EquipmentRow[]>`
      SELECT e.equipment_id, e.site_id, e.name, e.equip_type,
             t.display_name AS equip_type_name,
             e.parent_equipment_id, pe.name AS parent_name, e.notes,
             (SELECT count(*) FROM bas_points p WHERE p.equipment_id = e.equipment_id)::int
               AS point_count
        FROM bas_equipment e
        LEFT JOIN bas_equipment_types t ON t.equip_type = e.equip_type
        LEFT JOIN bas_equipment pe ON pe.equipment_id = e.parent_equipment_id
       WHERE e.site_id = ${siteId}
       ORDER BY e.name`,
    prisma.$queryRaw<Array<{ n: bigint }>>`
      SELECT count(*) AS n FROM bas_equipment WHERE site_id = ${siteId}`,
  ]);

  return {
    siteId: siteIdText,
    equipment: rows.map(toEquipment),
    equipmentAccountedFor: { rendered: rows.length, inDatabase: Number(total[0]?.n ?? 0) },
  };
}

async function assertEquipmentTypeExists(equipType: string): Promise<void> {
  const found = await prisma.basEquipmentType.findUnique({
    where: { equipType },
    select: { equipType: true },
  });
  if (found === null) {
    throw new BasError(
      "equipment_type_not_found",
      `${equipType} is not an equipment type in the vocabulary.`,
    );
  }
}

async function assertEquipmentNameFree(
  siteId: bigint,
  name: string,
  exceptEquipmentId: bigint | null,
): Promise<void> {
  const clash = await prisma.basEquipment.findUnique({
    where: { siteId_name: { siteId, name } },
    select: { equipmentId: true },
  });
  if (clash !== null && clash.equipmentId !== exceptEquipmentId) {
    throw new BasError(
      "name_taken",
      `Equipment called "${name}" already exists in this building.`,
    );
  }
}

/**
 * A parent on the same building whose chain does not loop back. Modelled on
 * assertNoParentCycle for stations; the FK is RESTRICT and says nothing about
 * A -> B -> A.
 */
async function assertEquipmentParent(
  equipmentId: bigint | null,
  parentId: bigint,
  siteId: bigint,
): Promise<{ name: string }> {
  if (equipmentId !== null && parentId === equipmentId) {
    throw new BasError("equipment_cycle", "Equipment cannot be its own parent.");
  }
  const parent = await prisma.basEquipment.findUnique({
    where: { equipmentId: parentId },
    select: { siteId: true, name: true },
  });
  if (parent === null || parent.siteId !== siteId) {
    // Conflated: a parent on another building reads like one that does not
    // exist, because the picker only ever offers this building's equipment.
    throw new BasError("equipment_not_found", "That parent equipment does not exist in this building.");
  }

  const total = await prisma.basEquipment.count({ where: { siteId } });
  const seen = new Set<string>();
  if (equipmentId !== null) seen.add(equipmentId.toString());
  let cursor: bigint | null = parentId;
  let hops = 0;
  while (cursor !== null) {
    const key = cursor.toString();
    if (seen.has(key)) {
      throw new BasError(
        "equipment_cycle",
        "That parent would make the equipment serve each other in a loop.",
      );
    }
    seen.add(key);
    if (++hops > total + 1) {
      throw new BasError(
        "equipment_cycle",
        "The parent chain does not terminate. Check the existing equipment.",
      );
    }
    const next: { parentEquipmentId: bigint | null } | null =
      await prisma.basEquipment.findUnique({
        where: { equipmentId: cursor },
        select: { parentEquipmentId: true },
      });
    cursor = next?.parentEquipmentId ?? null;
  }
  return { name: parent.name };
}

/**
 * Create equipment on a building (B8.5): the RTU, then the ten VAVs under it
 * with their rooms in `notes`. The building must be in the viewer's scope,
 * the type in the vocabulary, the name free within the building, and the
 * parent on the same building.
 */
export async function createBasEquipment(
  viewer: Viewer,
  input: CreateEquipmentInput,
): Promise<{ equipmentId: string }> {
  const siteId = BigInt(input.siteId);
  const { entitled } = await basSiteScope(viewer);
  const site = await prisma.$queryRaw<Array<{ site_id: bigint }>>`
    SELECT s.site_id FROM bas_sites s
     WHERE s.site_id = ${siteId} AND ${entitlementSql(entitled, Prisma.sql`s.site_id`)}`;
  if (site.length === 0) {
    throw new BasError("building_not_found", "That building does not exist.");
  }

  await assertEquipmentTypeExists(input.equipType);
  await assertEquipmentNameFree(siteId, input.name, null);
  const parentId =
    input.parentEquipmentId === undefined || input.parentEquipmentId === null
      ? null
      : BigInt(input.parentEquipmentId);
  const parent = parentId === null ? null : await assertEquipmentParent(null, parentId, siteId);

  const equipmentId = await prisma.$transaction(async (tx) => {
    const created = await tx.basEquipment.create({
      data: {
        siteId,
        name: input.name,
        equipType: input.equipType,
        parentEquipmentId: parentId,
        notes: input.notes ?? null,
      },
      select: { equipmentId: true },
    });
    await writeAuditEvent(tx, {
      action: "bas.equipment_created",
      actorEmployeeId: viewer.id,
      moduleKey: BAS_MODULE_KEY,
      metadata: {
        equipmentId: created.equipmentId.toString(),
        siteId: input.siteId,
        name: input.name,
        equipType: input.equipType,
        parentEquipmentId: parentId?.toString() ?? null,
        parentName: parent?.name ?? null,
        notes: input.notes ?? null,
      },
    });
    return created.equipmentId;
  });

  resetSchemaContextCache();
  return { equipmentId: equipmentId.toString() };
}

/**
 * Edit equipment (B8.5): name, type, parent, notes - only what was sent.
 * Reparenting is the edit that matters: the office VAVs were created and
 * THEN pointed at the RTU, and that order has to work. The audit row names
 * every field that moved with its previous value.
 */
export async function updateBasEquipment(
  viewer: Viewer,
  equipmentIdText: string,
  input: UpdateEquipmentInput,
): Promise<{ changed: boolean }> {
  if (!/^\d{1,18}$/.test(equipmentIdText)) {
    throw new BasError("equipment_not_found", "That equipment does not exist.");
  }
  const equipmentId = BigInt(equipmentIdText);
  const { entitled } = await basSiteScope(viewer);
  const rows = await prisma.$queryRaw<
    Array<{
      site_id: bigint;
      name: string;
      equip_type: string | null;
      parent_equipment_id: bigint | null;
      parent_name: string | null;
      notes: string | null;
    }>
  >`
    SELECT e.site_id, e.name, e.equip_type, e.parent_equipment_id, pe.name AS parent_name, e.notes
      FROM bas_equipment e
      LEFT JOIN bas_equipment pe ON pe.equipment_id = e.parent_equipment_id
     WHERE e.equipment_id = ${equipmentId}
       AND ${entitlementSql(entitled, Prisma.sql`e.site_id`)}`;
  const current = rows[0];
  if (current === undefined) {
    throw new BasError("equipment_not_found", "That equipment does not exist.");
  }

  const name = input.name ?? current.name;
  const equipType = input.equipType ?? current.equip_type;
  const notes = input.notes === undefined ? current.notes : input.notes;
  const parentId =
    input.parentEquipmentId === undefined
      ? current.parent_equipment_id
      : input.parentEquipmentId === null
        ? null
        : BigInt(input.parentEquipmentId);

  if (name !== current.name) await assertEquipmentNameFree(current.site_id, name, equipmentId);
  if (equipType !== null && equipType !== current.equip_type) {
    await assertEquipmentTypeExists(equipType);
  }
  let parentName = current.parent_name;
  if (parentId !== current.parent_equipment_id) {
    parentName =
      parentId === null
        ? null
        : (await assertEquipmentParent(equipmentId, parentId, current.site_id)).name;
  }

  const changed: string[] = [];
  if (name !== current.name) changed.push("name");
  if (equipType !== current.equip_type) changed.push("equipType");
  if (parentId !== current.parent_equipment_id) changed.push("parentEquipmentId");
  if (notes !== current.notes) changed.push("notes");
  if (changed.length === 0) return { changed: false };

  await prisma.$transaction(async (tx) => {
    await tx.basEquipment.update({
      where: { equipmentId },
      data: { name, equipType, parentEquipmentId: parentId, notes },
    });
    await writeAuditEvent(tx, {
      action: "bas.equipment_updated",
      actorEmployeeId: viewer.id,
      moduleKey: BAS_MODULE_KEY,
      metadata: {
        equipmentId: equipmentIdText,
        siteId: current.site_id.toString(),
        changed,
        name,
        previousName: current.name,
        equipType,
        previousEquipType: current.equip_type,
        parentEquipmentId: parentId?.toString() ?? null,
        previousParentEquipmentId: current.parent_equipment_id?.toString() ?? null,
        parentName,
        previousParentName: current.parent_name,
        notes,
        previousNotes: current.notes,
      },
    });
  });

  resetSchemaContextCache();
  return { changed: true };
}

/**
 * Delete equipment nothing depends on (B8.5). Refused - never cascaded - while
 * points are attached or other equipment sits under it; the FKs are RESTRICT
 * and this check turns the constraint into a sentence with the counts.
 */
export async function deleteBasEquipment(
  viewer: Viewer,
  equipmentIdText: string,
): Promise<{ deleted: boolean }> {
  if (!/^\d{1,18}$/.test(equipmentIdText)) {
    throw new BasError("equipment_not_found", "That equipment does not exist.");
  }
  const equipmentId = BigInt(equipmentIdText);
  const { entitled } = await basSiteScope(viewer);
  const rows = await prisma.$queryRaw<
    Array<{ site_id: bigint; name: string; points: number; children: number }>
  >`
    SELECT e.site_id, e.name,
           (SELECT count(*) FROM bas_points p WHERE p.equipment_id = e.equipment_id)::int AS points,
           (SELECT count(*) FROM bas_equipment c WHERE c.parent_equipment_id = e.equipment_id)::int AS children
      FROM bas_equipment e
     WHERE e.equipment_id = ${equipmentId}
       AND ${entitlementSql(entitled, Prisma.sql`e.site_id`)}`;
  const equipment = rows[0];
  if (equipment === undefined) {
    throw new BasError("equipment_not_found", "That equipment does not exist.");
  }

  const parts: string[] = [];
  if (equipment.points > 0) {
    parts.push(`${equipment.points} point${equipment.points === 1 ? "" : "s"} attached`);
  }
  if (equipment.children > 0) {
    parts.push(
      `${equipment.children} piece${equipment.children === 1 ? "" : "s"} of equipment under it`,
    );
  }
  if (parts.length > 0) {
    throw new BasError(
      "equipment_in_use",
      `${equipment.name} still has ${parts.join(" and ")}. Detach or move them first.`,
    );
  }

  await prisma.$transaction(async (tx) => {
    await tx.basEquipment.delete({ where: { equipmentId } });
    await writeAuditEvent(tx, {
      action: "bas.equipment_deleted",
      actorEmployeeId: viewer.id,
      moduleKey: BAS_MODULE_KEY,
      metadata: {
        equipmentId: equipmentIdText,
        siteId: equipment.site_id.toString(),
        name: equipment.name,
      },
    });
  });

  resetSchemaContextCache();
  return { deleted: true };
}

/**
 * The two vocabularies as this database holds them (B8.5). Read from the
 * tables, not from prisma/bas-vocabularies.ts, so the picker offers exactly
 * what the foreign keys will accept. Not viewer-scoped: a vocabulary is not
 * a building's data.
 */
export async function listBasVocabularies(): Promise<BasVocabularies> {
  const [roles, types] = await Promise.all([
    prisma.basPointRole.findMany({ orderBy: { pointRole: "asc" } }),
    prisma.basEquipmentType.findMany({ orderBy: [{ category: "asc" }, { displayName: "asc" }] }),
  ]);
  return {
    roles: roles.map((r) => ({
      pointRole: r.pointRole,
      displayName: r.displayName,
      description: r.description,
      measurement: r.measurement,
      typicalUnit: r.typicalUnit,
      isSetpoint: r.isSetpoint,
      isCommand: r.isCommand,
      isStatus: r.isStatus,
      setpointFor: r.setpointFor,
      statusOf: r.statusOf,
    })),
    equipmentTypes: types.map((t) => ({
      equipType: t.equipType,
      displayName: t.displayName,
      category: t.category,
    })),
  };
}

// ---------------------------------------------------------------------------
// Mutations (B7.3) - projects and buildings. Stations are B7.4.
// ---------------------------------------------------------------------------

/**
 * Every write below is wrapped in a transaction with its audit row, so a change
 * nobody can account for is not a state the database can reach. Same shape as
 * lib/admin/service.ts, deliberately - there is one way this codebase records a
 * change, and it is not worth a second.
 *
 * `viewer` is the actor. It is never taken from a request body.
 */

/** IANA zones PostgreSQL knows, cached for the process. */
let timezoneCache: Set<string> | null = null;

/** Test-only. Nothing in the application calls this. */
export function resetTimezoneCache(): void {
  timezoneCache = null;
}

/**
 * Checked against the database rather than a list in this repo.
 *
 * The zone has to be one THIS PostgreSQL accepts, because that is what
 * `bas_v_reading` hands to `AT TIME ZONE`. A hardcoded list would be a second
 * source of truth that is right until the container's tzdata moves.
 *
 * Cached because the set changes when tzdata does, which is a deploy and not a
 * request. Cached only when non-empty - an empty answer means the query failed
 * rather than that there are no timezones, and remembering that would reject
 * every zone until a restart.
 */
async function knownTimezones(): Promise<Set<string>> {
  if (timezoneCache !== null) return timezoneCache;

  const rows = await prisma.$queryRaw<Array<{ name: string }>>`
    SELECT name FROM pg_timezone_names`;

  const names = new Set(rows.map((r) => r.name));
  if (names.size > 0) timezoneCache = names;
  return names;
}

async function assertTimezone(value: string): Promise<void> {
  if (!(await knownTimezones()).has(value)) {
    throw new BasError(
      "invalid_timezone",
      value +
        " is not a timezone this server recognises. Use an IANA name such as America/New_York.",
    );
  }
}

/** Organisations a project can be created under. One row today. */
export async function listBasOrgs(
  viewer: Viewer,
): Promise<Array<{ orgId: string; name: string }>> {
  await basSiteScope(viewer);

  const orgs = await prisma.basOrg.findMany({
    select: { orgId: true, name: true },
    orderBy: { name: "asc" },
  });

  return orgs.map((o) => ({ orgId: o.orgId.toString(), name: o.name }));
}

export async function createBasProject(
  viewer: Viewer,
  input: CreateProjectInput,
): Promise<{ projectId: string }> {
  const orgId = BigInt(input.orgId);

  const org = await prisma.basOrg.findUnique({
    where: { orgId },
    select: { orgId: true },
  });
  if (org === null) {
    throw new BasError("org_not_found", "That organisation does not exist.");
  }

  // Checked before inserting so the message names the collision. The unique
  // index is still what makes it true - two admins submitting the same name at
  // the same moment get one row and one honest error, not two rows.
  const clash = await prisma.basProject.findUnique({
    where: { orgId_name: { orgId, name: input.name } },
    select: { projectId: true },
  });
  if (clash !== null) {
    throw new BasError(
      "name_taken",
      `A project called "${input.name}" already exists in this organisation.`,
    );
  }

  const projectId = await prisma.$transaction(async (tx) => {
    const created = await tx.basProject.create({
      data: { orgId, name: input.name, notes: input.notes ?? null },
      select: { projectId: true },
    });

    await writeAuditEvent(tx, {
      action: "bas.project_created",
      actorEmployeeId: viewer.id,
      moduleKey: BAS_MODULE_KEY,
      metadata: { projectId: created.projectId.toString(), name: input.name },
    });

    return created.projectId;
  });

  return { projectId: projectId.toString() };
}

export async function updateBasProject(
  viewer: Viewer,
  projectIdText: string,
  input: UpdateProjectInput,
): Promise<{ changed: boolean }> {
  const projectId = BigInt(projectIdText);

  const project = await prisma.basProject.findUnique({
    where: { projectId },
    select: { projectId: true, orgId: true, name: true, notes: true },
  });
  if (project === null) {
    throw new BasError("project_not_found", "That project does not exist.");
  }

  const name = input.name ?? project.name;
  const notes = input.notes === undefined ? project.notes : input.notes;

  if (name !== project.name) {
    const clash = await prisma.basProject.findUnique({
      where: { orgId_name: { orgId: project.orgId, name } },
      select: { projectId: true },
    });
    if (clash !== null) {
      throw new BasError(
        "name_taken",
        `A project called "${name}" already exists in this organisation.`,
      );
    }
  }

  // Nothing actually different: no write and no audit row. An admin who opened
  // the form and pressed Save has not changed anything, and a log that says they
  // did is a log that has to be discounted when read.
  if (name === project.name && notes === project.notes) {
    return { changed: false };
  }

  await prisma.$transaction(async (tx) => {
    await tx.basProject.update({ where: { projectId }, data: { name, notes } });

    await writeAuditEvent(tx, {
      action: "bas.project_updated",
      actorEmployeeId: viewer.id,
      moduleKey: BAS_MODULE_KEY,
      metadata: {
        projectId: projectIdText,
        name,
        // The old name, so the log answers "what was this called before"
        // without needing the row it just overwrote.
        previousName: project.name,
      },
    });
  });

  return { changed: true };
}

export async function deleteBasProject(
  viewer: Viewer,
  projectIdText: string,
): Promise<{ deleted: boolean }> {
  const projectId = BigInt(projectIdText);

  const project = await prisma.basProject.findUnique({
    where: { projectId },
    select: { projectId: true, name: true, _count: { select: { sites: true } } },
  });
  if (project === null) {
    throw new BasError("project_not_found", "That project does not exist.");
  }

  // A project is not deletable out from under its buildings. bas_sites.project_id
  // is RESTRICT so the database would refuse regardless; this exists so the
  // refusal is a sentence rather than a constraint name.
  if (project._count.sites > 0) {
    const n = project._count.sites;
    throw new BasError(
      "project_has_buildings",
      `"${project.name}" still has ${n} building${n === 1 ? "" : "s"}. Move or delete them first.`,
    );
  }

  await prisma.$transaction(async (tx) => {
    await tx.basProject.delete({ where: { projectId } });
    await writeAuditEvent(tx, {
      action: "bas.project_deleted",
      actorEmployeeId: viewer.id,
      moduleKey: BAS_MODULE_KEY,
      metadata: { projectId: projectIdText, name: project.name },
    });
  });

  return { deleted: true };
}

export async function createBasBuilding(
  viewer: Viewer,
  input: CreateBuildingInput,
): Promise<{ siteId: string }> {
  const projectId = BigInt(input.projectId);

  const project = await prisma.basProject.findUnique({
    where: { projectId },
    select: { projectId: true, orgId: true },
  });
  if (project === null) {
    throw new BasError("project_not_found", "That project does not exist.");
  }

  await assertTimezone(input.timezone);

  // Unique within the PROJECT. A building called "North Building" in another
  // project is not a collision, which is the whole reason the key moved in
  // B7.1 - and the reason this looks up by projectId and not by orgId.
  const clash = await prisma.basSite.findUnique({
    where: { projectId_name: { projectId, name: input.name } },
    select: { siteId: true },
  });
  if (clash !== null) {
    throw new BasError(
      "name_taken",
      `A building called "${input.name}" already exists in this project.`,
    );
  }

  const siteId = await prisma.$transaction(async (tx) => {
    const created = await tx.basSite.create({
      data: {
        // org_id is carried on the building as well as on its project, and the
        // bas_sites_project_org_match trigger refuses a row where the two
        // disagree. Taking it from the project rather than from the request is
        // what keeps that true - the form never sends an org.
        orgId: project.orgId,
        projectId,
        name: input.name,
        timezone: input.timezone,
        address: input.address ?? null,
        notes: input.notes ?? null,
      },
      select: { siteId: true },
    });

    await writeAuditEvent(tx, {
      action: "bas.building_created",
      actorEmployeeId: viewer.id,
      moduleKey: BAS_MODULE_KEY,
      metadata: {
        siteId: created.siteId.toString(),
        projectId: input.projectId,
        name: input.name,
        timezone: input.timezone,
      },
    });

    return created.siteId;
  });

  return { siteId: siteId.toString() };
}

export async function updateBasBuilding(
  viewer: Viewer,
  siteIdText: string,
  input: UpdateBuildingInput,
): Promise<{ changed: boolean }> {
  const siteId = BigInt(siteIdText);

  const site = await prisma.basSite.findUnique({
    where: { siteId },
    select: {
      siteId: true,
      projectId: true,
      name: true,
      timezone: true,
      address: true,
      notes: true,
    },
  });
  if (site === null) {
    throw new BasError("building_not_found", "That building does not exist.");
  }

  const name = input.name ?? site.name;
  const zone = input.timezone ?? site.timezone;
  const address = input.address === undefined ? site.address : input.address;
  const notes = input.notes === undefined ? site.notes : input.notes;

  if (zone !== site.timezone) await assertTimezone(zone);

  if (name !== site.name) {
    const clash = await prisma.basSite.findUnique({
      where: { projectId_name: { projectId: site.projectId, name } },
      select: { siteId: true },
    });
    if (clash !== null) {
      throw new BasError(
        "name_taken",
        `A building called "${name}" already exists in this project.`,
      );
    }
  }

  if (
    name === site.name &&
    zone === site.timezone &&
    address === site.address &&
    notes === site.notes
  ) {
    return { changed: false };
  }

  await prisma.$transaction(async (tx) => {
    await tx.basSite.update({
      where: { siteId },
      data: { name, timezone: zone, address, notes },
    });

    await writeAuditEvent(tx, {
      action: "bas.building_updated",
      actorEmployeeId: viewer.id,
      moduleKey: BAS_MODULE_KEY,
      metadata: {
        siteId: siteIdText,
        name,
        previousName: site.name,
        timezone: zone,
        // Recorded whenever it moves. Every stored reading is UTC and the zone
        // is what renders it locally, so a change here silently re-reads years
        // of history - this log line is the only place that would ever say when.
        previousTimezone: site.timezone,
      },
    });
  });

  return { changed: true };
}

export async function deleteBasBuilding(
  viewer: Viewer,
  siteIdText: string,
): Promise<{ deleted: boolean }> {
  const siteId = BigInt(siteIdText);

  const site = await prisma.basSite.findUnique({
    where: { siteId },
    select: {
      siteId: true,
      name: true,
      _count: { select: { stations: true, equipment: true } },
    },
  });
  if (site === null) {
    throw new BasError("building_not_found", "That building does not exist.");
  }

  // Stations carry points, and points carry readings that exist nowhere else in
  // the world (runbook.md, BAS irreplaceability). The FKs are RESTRICT the whole
  // way down so nothing here could cascade - but the refusal should still name
  // what is in the way rather than surfacing a constraint.
  const parts: string[] = [];
  if (site._count.stations > 0) {
    const n = site._count.stations;
    parts.push(`${n} station${n === 1 ? "" : "s"}`);
  }
  if (site._count.equipment > 0) {
    const n = site._count.equipment;
    parts.push(`${n} piece${n === 1 ? "" : "s"} of equipment`);
  }
  if (parts.length > 0) {
    throw new BasError(
      "building_has_stations",
      `"${site.name}" still has ${parts.join(" and ")}. Remove them first.`,
    );
  }

  await prisma.$transaction(async (tx) => {
    await tx.basSite.delete({ where: { siteId } });
    await writeAuditEvent(tx, {
      action: "bas.building_deleted",
      actorEmployeeId: viewer.id,
      moduleKey: BAS_MODULE_KEY,
      metadata: { siteId: siteIdText, name: site.name },
    });
  });

  return { deleted: true };
}

// ---------------------------------------------------------------------------
// Stations and their credentials (B7.4)
// ---------------------------------------------------------------------------

/**
 * NOTHING BELOW EVER RETURNS A PASSWORD, and nothing below logs one.
 *
 * `setBasStationCredential` takes a plaintext, hands it straight to
 * `encryptPassword`, and stores the envelope. The plaintext is not put in an
 * audit payload, not interpolated into an error, and not held in a variable
 * that outlives the call. `tests/bas-credentials.test.ts` walks every settings
 * route asserting no response body contains either the plaintext or the
 * ciphertext, and throws from the middle of a save to check the error too.
 */

/**
 * Walks the parent chain and refuses a cycle.
 *
 * `parent_station_id` is a nullable self-reference with a RESTRICT foreign key.
 * The FK stops a parent that does not exist; it says nothing about A -> B -> A,
 * which the database will happily store and which turns any later "follow the
 * chain to the collecting station" walk into an infinite loop.
 *
 * Bounded by the number of stations, so a pre-existing cycle - one written by
 * something other than this code - terminates rather than hanging the request.
 */
async function assertNoParentCycle(
  stationId: bigint | null,
  parentId: bigint,
): Promise<void> {
  if (stationId !== null && parentId === stationId) {
    throw new BasError(
      "station_cycle",
      "A station cannot import its own history.",
    );
  }

  const total = await prisma.basStation.count();
  const seen = new Set<string>();
  if (stationId !== null) seen.add(stationId.toString());

  let cursor: bigint | null = parentId;
  let hops = 0;

  while (cursor !== null) {
    const key = cursor.toString();
    if (seen.has(key)) {
      throw new BasError(
        "station_cycle",
        "That parent would make the stations import each other in a loop.",
      );
    }
    seen.add(key);

    if (++hops > total + 1) {
      // Only reachable if the existing data already contains a cycle. Refusing
      // is right: the request cannot be satisfied and the loop is real.
      throw new BasError(
        "station_cycle",
        "The parent chain does not terminate. Check the existing stations.",
      );
    }

    const next: { parentStationId: bigint | null } | null =
      await prisma.basStation.findUnique({
        where: { stationId: cursor },
        select: { parentStationId: true },
      });
    if (next === null) {
      throw new BasError("station_not_found", "That parent station does not exist.");
    }
    cursor = next.parentStationId;
  }
}

async function assertStationNameFree(
  siteId: bigint,
  name: string,
  exceptStationId: bigint | null,
): Promise<void> {
  const clash = await prisma.basStation.findUnique({
    where: { siteId_niagaraStationName: { siteId, niagaraStationName: name } },
    select: { stationId: true },
  });

  if (clash !== null && clash.stationId !== exceptStationId) {
    throw new BasError(
      "name_taken",
      `A station called "${name}" is already registered in this building.`,
    );
  }
}

export async function createBasStation(
  viewer: Viewer,
  input: CreateStationInput,
): Promise<{ stationId: string }> {
  const siteId = BigInt(input.siteId);

  const site = await prisma.basSite.findUnique({
    where: { siteId },
    select: { siteId: true },
  });
  if (site === null) {
    throw new BasError("building_not_found", "That building does not exist.");
  }

  // (site_id, niagara_station_name) is unique and STAYS unique: the collector's
  // ensure_station upserts on exactly that pair. Changing it would break a
  // cross-repo contract, so this checks it rather than working around it.
  await assertStationNameFree(siteId, input.niagaraStationName, null);

  const parentId =
    input.parentStationId === undefined || input.parentStationId === null
      ? null
      : BigInt(input.parentStationId);
  if (parentId !== null) await assertNoParentCycle(null, parentId);

  // A password with no key is refused BEFORE the station is created, so a
  // partial success - station registered, credential silently dropped - cannot
  // happen. The station is still creatable without one.
  if (input.password != null) requireCredentialKey();

  const stationId = await prisma.$transaction(async (tx) => {
    const created = await tx.basStation.create({
      data: {
        siteId,
        // Verbatim. Not trimmed, not case-folded - it is in every oBIX URL.
        niagaraStationName: input.niagaraStationName,
        displayName: input.displayName ?? null,
        connectionMode: input.connectionMode,
        // Also verbatim. The live value has no trailing slash and adding one
        // produces //obix.
        baseUrl: input.baseUrl ?? null,
        parentStationId: parentId,
        tlsSha256: input.tlsSha256 ?? null,
        notes: input.notes ?? null,
      },
      select: { stationId: true },
    });

    await writeAuditEvent(tx, {
      action: "bas.station_created",
      actorEmployeeId: viewer.id,
      moduleKey: BAS_MODULE_KEY,
      metadata: {
        stationId: created.stationId.toString(),
        siteId: input.siteId,
        niagaraStationName: input.niagaraStationName,
        connectionMode: input.connectionMode,
      },
    });

    if (input.password != null) {
      await writeCredential(tx, {
        stationId: created.stationId,
        username: input.username ?? "",
        password: input.password,
        actorId: viewer.id,
      });
    }

    return created.stationId;
  });

  return { stationId: stationId.toString() };
}

export async function updateBasStation(
  viewer: Viewer,
  stationIdText: string,
  input: UpdateStationInput,
): Promise<{ changed: boolean }> {
  const stationId = BigInt(stationIdText);

  const station = await prisma.basStation.findUnique({
    where: { stationId },
    select: {
      stationId: true,
      siteId: true,
      niagaraStationName: true,
      displayName: true,
      connectionMode: true,
      baseUrl: true,
      parentStationId: true,
      tlsSha256: true,
      notes: true,
      isActive: true,
    },
  });
  if (station === null) {
    throw new BasError("station_not_found", "That station does not exist.");
  }

  const name = input.niagaraStationName ?? station.niagaraStationName;
  const mode = input.connectionMode ?? station.connectionMode;
  const displayName =
    input.displayName === undefined ? station.displayName : input.displayName;
  const baseUrl = input.baseUrl === undefined ? station.baseUrl : input.baseUrl;
  const tls = input.tlsSha256 === undefined ? station.tlsSha256 : input.tlsSha256;
  const notes = input.notes === undefined ? station.notes : input.notes;
  const isActive = input.isActive ?? station.isActive;
  const parentId =
    input.parentStationId === undefined
      ? station.parentStationId
      : input.parentStationId === null
        ? null
        : BigInt(input.parentStationId);

  if (name !== station.niagaraStationName) {
    await assertStationNameFree(station.siteId, name, stationId);
  }
  if (parentId !== null && parentId !== station.parentStationId) {
    await assertNoParentCycle(stationId, parentId);
  }

  const unchanged =
    name === station.niagaraStationName &&
    displayName === station.displayName &&
    mode === station.connectionMode &&
    baseUrl === station.baseUrl &&
    parentId === station.parentStationId &&
    tls === station.tlsSha256 &&
    notes === station.notes &&
    isActive === station.isActive;

  if (unchanged) return { changed: false };

  await prisma.$transaction(async (tx) => {
    await tx.basStation.update({
      where: { stationId },
      data: {
        niagaraStationName: name,
        displayName,
        connectionMode: mode,
        baseUrl,
        parentStationId: parentId,
        tlsSha256: tls,
        notes,
        isActive,
      },
    });

    await writeAuditEvent(tx, {
      action: "bas.station_updated",
      actorEmployeeId: viewer.id,
      moduleKey: BAS_MODULE_KEY,
      metadata: {
        stationId: stationIdText,
        niagaraStationName: name,
        // The Niagara name is the identifier every oBIX URL is built from, so a
        // rename is not cosmetic and the old value has to survive somewhere.
        previousNiagaraStationName: station.niagaraStationName,
        connectionMode: mode,
        previousConnectionMode: station.connectionMode,
      },
    });
  });

  return { changed: true };
}

export async function deleteBasStation(
  viewer: Viewer,
  stationIdText: string,
): Promise<{ deleted: boolean }> {
  const stationId = BigInt(stationIdText);

  const station = await prisma.basStation.findUnique({
    where: { stationId },
    select: {
      stationId: true,
      niagaraStationName: true,
      _count: { select: { points: true, childStations: true, ingestRuns: true } },
    },
  });
  if (station === null) {
    throw new BasError("station_not_found", "That station does not exist.");
  }

  // Points carry readings that exist nowhere else in the world - the station
  // overwrote them roughly 42 hours after recording them (runbook.md, BAS
  // irreplaceability). The FK is RESTRICT so this cannot cascade; the check is
  // here so the refusal names the count instead of a constraint.
  const parts: string[] = [];
  if (station._count.points > 0) {
    const n = station._count.points;
    parts.push(`${n} point${n === 1 ? "" : "s"}`);
  }
  if (station._count.childStations > 0) {
    const n = station._count.childStations;
    parts.push(`${n} station${n === 1 ? "" : "s"} importing through it`);
  }
  if (station._count.ingestRuns > 0) {
    const n = station._count.ingestRuns;
    parts.push(`${n} recorded collector run${n === 1 ? "" : "s"}`);
  }
  if (parts.length > 0) {
    throw new BasError(
      "station_has_points",
      `${station.niagaraStationName} still has ${parts.join(", ")}. ` +
        `Mark it inactive instead if it is no longer collected.`,
    );
  }

  await prisma.$transaction(async (tx) => {
    // The credential row cascades from the station - see the schema. A deleted
    // station must not leave a stored secret behind with nothing pointing at it.
    await tx.basStation.delete({ where: { stationId } });
    await writeAuditEvent(tx, {
      action: "bas.station_deleted",
      actorEmployeeId: viewer.id,
      moduleKey: BAS_MODULE_KEY,
      metadata: {
        stationId: stationIdText,
        niagaraStationName: station.niagaraStationName,
      },
    });
  });

  return { deleted: true };
}

// ------------------------------------------------------------- credentials

function requireCredentialKey(): void {
  const state = credentialKeyState();
  if (!state.available) throw new CredentialError(state.reason);
}

/**
 * The only function in the codebase that writes a password.
 *
 * The audit row records the station and the actor. It does NOT record the
 * username, and emphatically not the password: a payload that carried either
 * would put a credential in a table that is deliberately append-only and never
 * deleted.
 */
async function writeCredential(
  tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0],
  args: {
    stationId: bigint;
    username: string;
    password: string;
    actorId: string;
  },
): Promise<void> {
  const ciphertext = encryptPassword(args.password);
  const keyVersion = currentKeyVersion();

  await tx.basStationCredential.upsert({
    where: { stationId: args.stationId },
    create: {
      stationId: args.stationId,
      username: args.username,
      passwordCiphertext: ciphertext,
      keyVersion,
      updatedById: args.actorId,
    },
    update: {
      username: args.username,
      passwordCiphertext: ciphertext,
      keyVersion,
      updatedById: args.actorId,
    },
  });

  await writeAuditEvent(tx, {
    action: "bas.credential_set",
    actorEmployeeId: args.actorId,
    moduleKey: BAS_MODULE_KEY,
    // Station, username, key version. NEVER the password.
    //
    // The username was deliberately left out at first, on the grounds that
    // audit_events is append-only and so anything written here can never be
    // redacted. That reasoning was backwards. Append-only is a reason TO record
    // it: swapping a station's login from `bas_collector` to `admin` is a
    // privilege escalation on a building controller, and without the username
    // the log shows only that *something* changed. A username is not a secret;
    // the password is, and it is not here.
    metadata: {
      stationId: args.stationId.toString(),
      username: args.username,
      keyVersion,
    },
  });
}

export async function setBasStationCredential(
  viewer: Viewer,
  stationIdText: string,
  input: SetCredentialInput,
): Promise<{ passwordSet: true }> {
  const stationId = BigInt(stationIdText);

  // Before anything else, so a missing key is reported as a configuration
  // problem rather than after a partial write.
  requireCredentialKey();

  const station = await prisma.basStation.findUnique({
    where: { stationId },
    select: { stationId: true },
  });
  if (station === null) {
    throw new BasError("station_not_found", "That station does not exist.");
  }

  await prisma.$transaction(async (tx) => {
    await writeCredential(tx, {
      stationId,
      username: input.username,
      password: input.password,
      actorId: viewer.id,
    });
  });

  return { passwordSet: true };
}

export async function clearBasStationCredential(
  viewer: Viewer,
  stationIdText: string,
): Promise<{ cleared: boolean }> {
  const stationId = BigInt(stationIdText);

  const existing = await prisma.basStationCredential.findUnique({
    where: { stationId },
    select: { stationId: true },
  });
  if (existing === null) return { cleared: false };

  await prisma.$transaction(async (tx) => {
    await tx.basStationCredential.delete({ where: { stationId } });
    await writeAuditEvent(tx, {
      action: "bas.credential_cleared",
      actorEmployeeId: viewer.id,
      moduleKey: BAS_MODULE_KEY,
      metadata: { stationId: stationIdText },
    });
  });

  return { cleared: true };
}

/**
 * Whether credential management is usable at all, for the UI to render around.
 *
 * A missing key disables this one feature. The rest of Settings works, which is
 * the point of reading the key lazily rather than at import.
 */
export function basCredentialAvailability(): {
  available: boolean;
  message: string | null;
} {
  const state = credentialKeyState();
  return state.available
    ? { available: true, message: null }
    : { available: false, message: new CredentialError(state.reason).message };
}
