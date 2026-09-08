/**
 * The domain vocabulary of the Building Automation module.
 *
 * Route handlers and components use these types. Nothing above the service ever
 * sees a SQL row, a `bigint`, or a view name - the same boundary
 * lib/modules/change-orders/mail/types.ts draws around Graph.
 *
 * Two conversions happen at that boundary and are worth naming, because both are
 * silent corruption if they are missed:
 *
 *  - `point_id` is a PostgreSQL `bigint`, which Prisma hands back as a JS
 *    `BigInt`. `JSON.stringify` throws on one. Point ids are carried as strings.
 *  - timestamps are carried as ISO 8601 strings in UTC, formatted for display in
 *    the browser's zone. Every BAS timestamp is stored `timestamptz` (docs/08,
 *    *Four invariants*); local time is a rendering choice, never a stored one.
 */

/**
 * `roll_risk` from `bas_v_collection_health`, unchanged. The view is the only
 * thing that decides which one a point is in; nothing here re-derives it.
 *
 * `roll_horizon_unknown` means capacity or collection_interval_s has not been
 * filled in from Workbench, so the horizon cannot be computed and we do not know
 * whether records are being destroyed. **It is not `ok`.** See
 * `basRiskTone` in app/(modules)/bas/health-client.ts for where that is enforced
 * for display, and tests/bas-health-ui.test.ts for the assertion that it holds.
 */
export type RollRisk =
  | "ok"
  | "at_risk"
  | "data_lost"
  | "roll_horizon_unknown"
  | "never_collected";

/** Every risk except `ok`. What the "points at risk of data loss" tile counts. */
export const AT_RISK_ROLL_RISKS: readonly RollRisk[] = [
  "data_lost",
  "at_risk",
  "roll_horizon_unknown",
  "never_collected",
];

export interface CollectionHealthTotals {
  /** Active points. Inactive ones are excluded everywhere on this screen. */
  activePoints: number;
  /** Every reading row, matching the Grafana "Total readings" panel. */
  totalReadings: number;
  /** Active points with no `point_role`. A backlog, not an error. */
  unclassifiedPoints: number;
  /** Active points in any risk state other than `ok`. */
  pointsAtRisk: number;
  /** The composition of `pointsAtRisk`, so a total of 3 is never ambiguous. */
  riskCounts: Record<RollRisk, number>;
  /**
   * Minutes since the newest reading in the whole database.
   *
   * `null` when there are no readings at all. That is deliberately not `0`: zero
   * minutes ago is the healthiest possible answer and "we have never collected
   * anything" is close to the worst, and they must not render the same.
   */
  minutesSinceNewestReading: number | null;
}

export interface PointHealthRow {
  pointId: string;
  pointName: string;
  siteName: string;
  /** `null` for an unclassified point. */
  pointRole: string | null;
  unit: string | null;
  risk: RollRisk;
  /** ISO 8601 UTC, or `null` when the point has never been collected. */
  lastReadingAt: string | null;
  minutesAgo: number | null;
  /** Hours, or `null` when capacity or interval is unknown - i.e. the risk state. */
  rollHorizonHours: number | null;
}

export interface IngestRunRow {
  runId: string;
  startedAt: string;
  finishedAt: string | null;
  status: "running" | "ok" | "partial" | "failed";
  pointsSucceeded: number;
  pointsAttempted: number;
  recordsWritten: number;
  collectorHost: string | null;
  /** How many errors the run recorded. The payloads themselves stay in the row. */
  errorCount: number;
}

/** One bar of the "records written per collector run" chart. */
export interface RunRecordPoint {
  /** Epoch milliseconds. The chart's x axis is real time, not run number. */
  startedAtMs: number;
  recordsWritten: number;
}

/**
 * The longest interval between two consecutive collector runs in the window.
 *
 * This exists because a bar chart and a list of runs both make an outage look
 * like fewer rows rather than like damage. Compared against `rollHorizonHours`,
 * a gap longer than the horizon means the station overwrote records while nobody
 * was reading, and they are gone - which is the single condition this screen is
 * for.
 */
export interface RunGap {
  fromAt: string;
  toAt: string;
  hours: number;
  /** Shortest horizon among active points, in hours. `null` if none is known. */
  rollHorizonHours: number | null;
  /** `true` only when the horizon is known AND the gap is longer than it. */
  exceedsRollHorizon: boolean;
}

export interface DataGapRow {
  gapId: string;
  pointName: string;
  siteName: string;
  gapStart: string;
  gapEnd: string;
  /**
   * When the gap was RECORDED, which is not when it happened.
   *
   * A gap is discovered after the fact - `gap_start` can be weeks before anyone
   * noticed - so this is the only field that can answer "is this new to me
   * since I last looked". Home dates its "since you last signed in" list from
   * here; dating it from `gapStart` would hide a gap recorded this morning
   * about a silence last month, which is exactly the one worth surfacing.
   */
  detectedAt: string;
  hoursLost: number;
  cause: string;
  notes: string | null;
}

/** One entry in the building filter. */
export interface SiteOption {
  siteId: string;
  name: string;
  orgName: string;
}

export interface CollectionHealth {
  /**
   * Days of history the run list, the run chart and the run-gap calculation
   * cover. The tiles, the per-point table and the recorded gaps are statements
   * about the present and are not windowed - see `getCollectionHealth`.
   */
  windowDays: number;

  /**
   * Every site this employee may look at, whatever they are currently looking
   * at. It is the building filter's option list, so it must never be narrowed
   * by the current selection - a dropdown that dropped its other options once
   * you picked one could not be used to pick again.
   */
  sites: SiteOption[];

  /** `null` is "All buildings", which is the default. */
  selectedSiteId: string | null;

  /** Resolved here so the screen never has to look it up in `sites`. */
  selectedSiteName: string | null;
  /** The server's `now()`, shared by every figure in this payload. */
  observedAt: string;
  totals: CollectionHealthTotals;
  points: PointHealthRow[];
  runs: IngestRunRow[];

  /**
   * When the newest collector run started, ignoring the window entirely.
   *
   * The whole point of it is the case where `runs` is empty. A short window over
   * a collector that stopped three days ago produces an empty run list, and an
   * empty list reads as "nothing to report" when it means the opposite. This is
   * what lets the empty state say *when* it last ran instead.
   *
   * `null` means it has genuinely never run against this database.
   */
  newestRunAt: string | null;

  runRecords: RunRecordPoint[];
  longestRunGap: RunGap | null;
  dataGaps: DataGapRow[];
}

// ---------------------------------------------------------------- B4

/** One entry in the point picker. */
export interface PointOption {
  pointId: string;
  /** `display_name` falling back to the Niagara history name, as the view does. */
  pointName: string;
  pointRole: string | null;
  unit: string | null;
  siteName: string;
}

/**
 * One sample on the trend chart.
 *
 * `value` is `null` for two different reasons and the chart treats them the
 * same way on purpose - it cannot draw a line through either:
 *
 *  1. A row exists with no populated value column. The station logged an entry
 *     and had nothing to put in it: a sensor fault. It is a RECORD.
 *  2. A synthetic break inserted where consecutive rows are further apart than
 *     the point's collection interval allows. There is NO record.
 *
 * `isBreak` says which. The distinction is the whole of docs/08's *A null
 * reading is not a missing reading*, and it is carried in the payload rather
 * than re-derived in the browser so that the tiles and the chart cannot drift
 * apart about it.
 */
export interface TrendPoint {
  tsMs: number;
  value: number | null;
  /** `true` only for a synthetic break. A real null-valued row is `false`. */
  isBreak: boolean;
}

/**
 * A stretch of time with no readings at all, derived from the readings
 * themselves rather than from `bas_data_gaps`.
 *
 * Both are shown, and they answer different questions. This one is "the chart
 * has nothing to draw here". `DataGapRow` is "somebody recorded that we know we
 * missed this, and why". A gap can appear here without being recorded, which is
 * exactly the case worth seeing.
 */
export interface TrendGap {
  fromMs: number;
  toMs: number;
  hours: number;
}

export interface PointStats {
  /** Rows in the window, including any with no populated value column. */
  readings: number;
  /** Of those rows, how many carried no value. NOT the same as a missing row. */
  nullRecords: number;
  /**
   * Distinct non-null numeric values in the window.
   *
   * The stuck-sensor signal, and deliberately NOT standard deviation. A
   * threshold on sigma is unit-dependent and untunable across buildings - it
   * missed a sensor frozen at 64.5 with sigma 0.08. A live sensor sampling the
   * physical world produces many distinct values; a dead one produces a handful,
   * and that holds whatever the units are. docs/08, *Point Explorer*.
   */
  distinctValues: number;
  /** Most recent non-null value in the window, and when. */
  latest: number | null;
  latestAt: string | null;
  average: number | null;
  minimum: number | null;
  maximum: number | null;
}

export interface PointExplorer {
  windowDays: number;
  observedAt: string;

  sites: SiteOption[];
  selectedSiteId: string | null;
  selectedSiteName: string | null;

  /** Every point the picker offers, scoped by the building filter. */
  points: PointOption[];
  /** `null` when there is no point to show - an empty database, or none active. */
  selectedPoint: PointOption | null;

  /**
   * The point's configured seconds between records, from `bas_points`.
   * `null` when capacity has not been filled in from Workbench. Used to decide
   * what counts as a break in the trend.
   */
  collectionIntervalS: number | null;

  stats: PointStats;
  trend: TrendPoint[];
  trendGaps: TrendGap[];
  /**
   * `true` when the window held more samples than the payload will carry, so
   * `trend` is the most recent slice rather than the whole window. Said out
   * loud on screen: a silently truncated chart is a chart that lies about when
   * the data starts.
   */
  trendTruncated: boolean;
  dataGaps: DataGapRow[];
}

// ---------------------------------------------------------------------------
// Settings (B7.2) - the read-only hierarchy.
// ---------------------------------------------------------------------------

/**
 * How a station's history reaches us, as the Settings tree reports it.
 *
 * `unconfigured` is not a value in the database. It is the pair
 * `connection_mode = 'via_parent'` with no `parent_station_id` - a station that
 * says its history arrives through another station, and does not say which. The
 * add_bas_projects migration deliberately allows that row rather than
 * CHECK-ing it away, because it is what a JACE linked in Workbench and not yet
 * labelled here actually looks like.
 */
export type StationReach = "direct" | "via_parent" | "unconfigured";

/**
 * What is known about a stored Niagara login - and it is deliberately not much.
 *
 * The username, that a password exists, and when it was last set. NEVER the
 * password and never the ciphertext: no API returns either, and
 * tests/bas-credentials.test.ts walks every settings route to prove it.
 *
 * `passwordSet` is always true when this object is present. It is a literal
 * rather than a boolean because the alternative - a credential row with no
 * password - is not a state that can exist, and a `false` here would invite a
 * caller to handle one.
 */
export interface SettingsCredential {
  username: string;
  passwordSet: true;
  passwordUpdatedAt: string;
}

/**
 * Whether the station is actually collecting, derived from what the collector
 * already wrote.
 *
 * THIS IS WHY THERE IS NO "TEST CONNECTION" BUTTON. Such a button would open a
 * socket from wherever the platform is running, which works on a laptop on the
 * building network and breaks permanently the moment this moves to Azure -
 * Azure cannot reach the building network, and Tridium's own guidance is that a
 * station is never internet-exposed. Only the collector can talk to a JACE.
 *
 * These three facts come from bas_ingest_runs and bas_sync_checkpoints, so they
 * are true from anywhere, including from Azure, and they answer the question
 * the button was for: is data arriving.
 */
export interface StationActivity {
  /** When a collector run last touched this station, whatever the outcome. */
  lastRunAt: string | null;
  /** That run's status: ok, partial, failed, running. */
  lastRunStatus: string | null;
  /** Newest record timestamp across this station's points. The real answer. */
  newestRecordAt: string | null;
}

export interface SettingsStation {
  stationId: string;
  /** Exactly as Niagara spells it. Never normalised - it is in every oBIX URL. */
  niagaraStationName: string;
  /** What a person calls it. Null means nobody has, and the UI shows the Niagara name. */
  displayName: string | null;
  reach: StationReach;
  /** Only meaningful when reach is 'direct'. Stored verbatim, trailing slash and all. */
  baseUrl: string | null;
  /** The station importing this one's history, when reach is 'via_parent'. */
  parentStationName: string | null;
  parentStationId: string | null;
  /**
   * SHA-256 of the station's TLS certificate, or null.
   *
   * Returned in full, unlike anything to do with the credential. A certificate
   * fingerprint is public by construction - anyone who can reach the station
   * can compute it - and its whole purpose is to be compared against.
   */
  tlsSha256: string | null;
  isActive: boolean;
  activePoints: number;
  totalPoints: number;
  lastSeenAt: string | null;
  /** True when this station has a credential row. Never the credential itself. */
  hasCredential: boolean;
  credential: SettingsCredential | null;
  activity: StationActivity;
}

export interface SettingsBuilding {
  siteId: string;
  name: string;
  timezone: string;
  address: string | null;
  stations: SettingsStation[];
}

export interface SettingsProject {
  projectId: string;
  name: string;
  orgName: string;
  buildings: SettingsBuilding[];
}

export interface SettingsOrg {
  orgId: string;
  name: string;
}

export interface BasSettingsTree {
  /**
   * Organisations a project can be created under. One row today.
   *
   * Carried in the tree so the create-project form has something to bind to
   * without a second round trip. Orgs are NOT managed on this screen - there is
   * no form for them, and a deployment with none disables project creation
   * rather than inventing one.
   */
  orgs: SettingsOrg[];

  projects: SettingsProject[];

  /**
   * Stations the hierarchy does not account for.
   *
   * Empty today and structurally so: `bas_stations.site_id` and
   * `bas_sites.project_id` are both NOT NULL, so every station has a building
   * and every building has a project. The bucket exists anyway because the
   * requirement is that a station collecting data is never invisible here, and
   * that has to be a property of the code rather than of a constraint someone
   * may relax later. `stationsAccountedFor` is what proves it.
   */
  unassignedStations: SettingsStation[];

  /**
   * Every station row in the database, counted independently of the tree.
   *
   * The screen compares this with what it rendered. If they ever disagree the
   * banner says so, because a tree that quietly drops a station is exactly the
   * silent gap this module keeps finding weeks late.
   */
  stationsAccountedFor: { rendered: number; inDatabase: number };

  /**
   * Whether BAS_CREDENTIAL_KEY is configured on this server.
   *
   * Read lazily. A missing key disables credential management and NOTHING else
   * - the tree, the projects, the buildings and the station forms all still
   * work. The screen says so rather than failing a save with an error nobody
   * can act on from a browser.
   */
  credentialStorage: { available: boolean; message: string | null };

  /**
   * Every station, flat, for the parent picker. Includes stations in other
   * buildings: a central station commonly imports history for JACEs across a
   * whole property, which is the arrangement D12 assumes.
   */
  allStations: Array<{
    stationId: string;
    niagaraStationName: string;
    siteName: string;
  }>;
}
