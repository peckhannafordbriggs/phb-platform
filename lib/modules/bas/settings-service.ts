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
import type {
  CreateBuildingInput,
  CreateProjectInput,
  CreateStationInput,
  SetCredentialInput,
  UpdateBuildingInput,
  UpdateProjectInput,
  UpdateStationInput,
} from "@/lib/validation/bas-settings";
import {
  COLLECTING_WITHIN_HOURS,
  NO_SETTINGS_FILTERS,
  settingsFiltersActive,
} from "./types";
import type {
  BasSettingsFilters,
  BasSettingsTree,
  SettingsBuilding,
  SettingsProject,
  SettingsStation,
  StationReach,
} from "./types";

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
    clauses.push(Prisma.sql`(
         st.display_name          ILIKE ${like} ESCAPE '\\'
      OR st.niagara_station_name  ILIKE ${like} ESCAPE '\\'
      OR st.base_url              ILIKE ${like} ESCAPE '\\'
      OR s.name                   ILIKE ${like} ESCAPE '\\'
      OR p.name                   ILIKE ${like} ESCAPE '\\'
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

  // The entitlement, applied to both queries. `null` is everyone today.
  const siteScope = (column: Prisma.Sql): Prisma.Sql =>
    entitled === null
      ? Prisma.sql`TRUE`
      : entitled.length === 0
        ? Prisma.sql`FALSE`
        : Prisma.sql`${column} IN (${Prisma.join(entitled)})`;

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
        count(pt.point_id) FILTER (WHERE pt.is_active) AS active_points,
        count(pt.point_id)                             AS total_points,
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
        max(ck.last_record_ts)                         AS newest_record_at
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
