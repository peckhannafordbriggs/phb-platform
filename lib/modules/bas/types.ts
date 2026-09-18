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
 * `roll_horizon_unknown` means no horizon is known - the history's capacity is
 * not recorded, or the station reports no record count - so we do not know
 * whether records are being destroyed. **It is not `ok`.** See `basRiskTone`
 * in app/(modules)/bas/health-client.ts for where that is enforced for
 * display, and tests/bas-health-ui.test.ts for the assertion that it holds.
 *
 * `buffer_not_full` (2026-09-18) is the state that used to be folded into
 * unknown and is not unknown at all: the station reports fewer records than
 * the history's capacity, so the buffer has never been seen full and NOTHING
 * has been overwritten. Six office points sat in this state and were counted
 * at risk. It is informational - not a warning, not a risk, and there is
 * nothing to fill in. A change-of-value trend has no interval; its horizon is
 * measured once the buffer fills.
 */
export type RollRisk =
  | "ok"
  | "at_risk"
  | "data_lost"
  | "buffer_not_full"
  | "roll_horizon_unknown"
  | "never_collected";

/**
 * Every risk except `ok` and `buffer_not_full`. What the "points at risk of
 * data loss" tile counts. `buffer_not_full` is absent on purpose: a buffer
 * below capacity has overwritten nothing, and counting it would be the
 * 2026-09-18 defect again.
 */
export const AT_RISK_ROLL_RISKS: readonly RollRisk[] = [
  "data_lost",
  "at_risk",
  "roll_horizon_unknown",
  "never_collected",
];

/**
 * `completeness` from `bas_v_collection_health`: the collector's per-pass
 * comparison of the station's own record count against what we hold inside
 * the station's span (phb-bas, `completeness_verdict`).
 *
 *   incomplete   the station holds records we do not, after asking for
 *                everything. Not lost yet; not arriving on its own. Red.
 *   backfilling  short, but the pass hit its request cap and the next one
 *                continues. Resolves itself. Amber - a backlog, like § 43.
 *   unknown      the station reported no count, or no pass has checked yet.
 *                Never green.
 *   complete     within tolerance of the station's own count.
 *
 * A point with no checkpoint row at all reads `unknown` - the service
 * COALESCEs it - because "never checked" must not render as "checked and
 * fine".
 */
export type Completeness = "unknown" | "complete" | "backfilling" | "incomplete";

/**
 * Why a point is not collected (2026-09-17). ONE closed set in two places:
 * this list and the CHECK bas_points_inactive_reason_check in the
 * add_bas_inactive_reason migration. tests/bas-schema.test.ts reads the
 * constraint back out of pg_constraint and asserts the two are identical, and
 * the collector (phb-bas, collector/reasons.py) does the same for its copy.
 *
 * alarm_history is deliberately NOT niagara_system_log: Global_Alarm is real
 * building data that needs a table of its own, excluded later rather than
 * never. no_longer_reported is what discover writes for a history the station
 * stopped reporting.
 */
export const INACTIVE_REASONS = [
  "niagara_system_log",
  "alarm_history",
  "reconfigured_cfg0",
  "manual",
  "no_longer_reported",
] as const;
export type InactiveReason = (typeof INACTIVE_REASONS)[number];

export function isInactiveReason(value: string | null): value is InactiveReason {
  return value !== null && (INACTIVE_REASONS as readonly string[]).includes(value);
}

/** Every completeness except `complete`, worst first. */
export const NOT_COMPLETE: readonly Completeness[] = [
  "incomplete",
  "backfilling",
  "unknown",
];

/**
 * Which horizon `rollHorizonHours` is: the shortest span the station's full
 * buffer has been seen to hold (measured), capacity x interval (configured),
 * or none.
 */
export type HorizonSource = "measured" | "configured" | null;

/**
 * `horizon_state` from `bas_v_collection_health`: the four-way word every
 * screen that shows a horizon uses (2026-09-18).
 *
 *   measured     the buffer has been seen full. The horizon is the SHORTEST
 *                full-buffer span ever observed, never the latest - a
 *                change-of-value point's span moves with how hard the
 *                equipment cycles, and Unit_Status_Mode went from two hours
 *                to ten in a day. A point whose buffer has ever spanned two
 *                hours is a two-hour point. The current span is carried
 *                beside it for display.
 *   configured   capacity x collection_interval_s: an interval trend with
 *                both filled in from Workbench, and no full buffer measured.
 *   not_full     the station reports fewer records than capacity. Nothing
 *                overwritten, no horizon to measure yet, nothing to fill in.
 *   unknown      capacity not recorded, or the station reports no count.
 *                Amber, never green.
 */
export type HorizonState = "measured" | "configured" | "not_full" | "unknown";

/** The view constrains this; a row is data. An unrecognised word is unknown, never measured. */
export function toHorizonState(value: string | null): HorizonState {
  return value === "measured" || value === "configured" || value === "not_full"
    ? value
    : "unknown";
}

/**
 * One point's horizon, as both screens render it. Built by the service from
 * the view and never re-derived on the client: the view is the only thing
 * that decides which state a point is in.
 */
export interface PointHorizon {
  state: HorizonState;
  /**
   * The horizon the guard and every risk figure use, in hours: the shortest
   * full-buffer span for `measured`, capacity x interval for `configured`,
   * null otherwise.
   */
  hours: number | null;
  /**
   * The span the station reports today, in hours, when its buffer is full
   * now. Null when it is not. Display only - the guard never reads it.
   */
  currentHours: number | null;
  /** The station's reported record count at the last check, or null. */
  stationCount: number | null;
  /** bas_points.capacity, or null when nobody has recorded it. */
  capacity: number | null;
}

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
   * Active points hidden from the browsing screens (B8.3). They are INSIDE
   * `activePoints`, inside `pointsAtRisk` and inside every completeness
   * count: hiding is a screen preference and changes nothing about
   * collection. This is how many rows the per-point table is not drawing.
   */
  hiddenPoints: number;
  /** How many of `pointsAtRisk` are hidden. Non-zero is what the screen must say out loud. */
  hiddenPointsAtRisk: number;
  /**
   * Points the collector turned off because the station stopped reporting
   * them (`inactive_reason = 'no_longer_reported'`). NOT in `pointsAtRisk`:
   * nothing is lagging a horizon, the history is gone from the station. And
   * not silent either - `CollectionHealth.vanished` names each one. Before
   * this existed a point vanishing REMOVED it from every figure on the
   * screen, so a deleted trend made the dashboard look better. The four
   * deliberate reasons are not counted anywhere here; we chose those.
   */
  pointsNoLongerReported: number;
  /** Active points whose last check said the station holds records we do not. */
  pointsIncomplete: number;
  /** Every completeness state's count, so the tile can say which. */
  completenessCounts: Record<Completeness, number>;
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
  /**
   * Hours, or `null` when no horizon is known - i.e. the risk state. Measured
   * from the station's own span when its buffer is full, else configured from
   * capacity x interval; `horizonSource` says which.
   */
  rollHorizonHours: number | null;
  horizonSource: HorizonSource;
  /**
   * The same horizon with its state and the numbers the screen shows beside
   * it. `horizon.hours` equals `rollHorizonHours`; the two older fields stay
   * because the headroom badge and the oracle script read them.
   */
  horizon: PointHorizon;
  completeness: Completeness;
  /** The station's reported record count at the last check, or `null`. */
  stationCount: number | null;
  /** Rows we hold inside the station's span at the last check, or `null`. */
  heldCount: number | null;
  /**
   * bas_points.is_visible (B8.3). The service returns every active point and
   * the SCREEN leaves hidden ones out of its table, so that the tiles, the
   * completeness card and the headroom badge - all computed over this list
   * or over the same rows - cannot lose a point a person hid.
   */
  visible: boolean;
}

/**
 * A point the collector turned off because the station stopped reporting its
 * history. Listed by name with when a record last arrived, because "1 point
 * vanished" sends somebody to a query and "Occupied, last record 12 Aug"
 * sends them to Workbench.
 */
export interface VanishedPoint {
  pointId: string;
  pointName: string;
  siteName: string;
  stationName: string;
  /** ISO 8601 UTC, or `null` when no record was ever collected from it. */
  lastReadingAt: string | null;
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

export interface ProjectOption {
  projectId: string;
  name: string;
  orgName: string;
}

export interface StationOption {
  stationId: string;
  /** display_name falling back to the Niagara name, as the pickers show it. */
  name: string;
  siteName: string;
}

/**
 * What the four controls currently select, and what that means (B7.6).
 *
 * `label` is the selection in words - "Liberty Center -> North Building" - and
 * it is on the payload rather than composed in the component so the scope line,
 * the per-tile qualifiers and the outside-this-filter warning cannot describe
 * the same selection three slightly different ways.
 */
export interface BasScope {
  filtered: boolean;
  label: string | null;
}

/**
 * The same figures WITHOUT the filter, and the reason this exists.
 *
 * With a filter active every tile counts only the filtered set. That is right,
 * and it is also how somebody reads "0 points at risk" in one building and
 * concludes nothing anywhere is at risk. Three outages have already destroyed
 * about 117 hours per point and one of them went unnoticed for eight days.
 *
 * `null` when nothing is filtered, because then it would be the same numbers
 * twice. Scoped to the employee's entitlement, so "outside this filter" never
 * means "outside your permissions".
 */
export interface UnfilteredTotals {
  activePoints: number;
  pointsAtRisk: number;
  /** Same rule as `pointsAtRisk`: a vanished point outside the filter is still said. */
  pointsNoLongerReported: number;
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

  /**
   * The other two levels of the cascade (B7.6). Each list is narrowed by the
   * level above it - buildings by the chosen project, JACEs by both - which is
   * what stops somebody selecting a building that is not in the project they
   * picked and getting a blank screen with nothing saying why.
   */
  projects: ProjectOption[];
  stations: StationOption[];

  /** `null` is "All", which is the default at every level. */
  selectedSiteId: string | null;
  /** Resolved here so the screen never has to look it up in `sites`. */
  selectedSiteName: string | null;
  selectedProjectId: string | null;
  selectedProjectName: string | null;
  selectedStationId: string | null;
  selectedStationName: string | null;

  scope: BasScope;
  unfiltered: UnfilteredTotals | null;
  /** The server's `now()`, shared by every figure in this payload. */
  observedAt: string;
  totals: CollectionHealthTotals;
  points: PointHealthRow[];
  /**
   * Every point in scope the station no longer reports. Always present, and
   * an empty list is a claim the screen makes out loud - see VanishedCard.
   */
  vanished: VanishedPoint[];
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
  /** The other two levels of the cascade (B7.6). They narrow the POINT list. */
  projects: ProjectOption[];
  stations: StationOption[];
  selectedProjectId: string | null;
  selectedProjectName: string | null;
  selectedStationId: string | null;
  selectedStationName: string | null;
  scope: BasScope;
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
  /**
   * Whether ANY collector run against this station has ever succeeded.
   *
   * The one fact that separates two stations that both have no login stored.
   * One was registered this afternoon and is waiting for somebody to find the
   * password - a backlog item, amber, the same category as an unclassified
   * point. The other was collecting last week and cannot be today - a fault,
   * red. Whether a credential row ever existed is not recorded anywhere and
   * does not need to be; the ingest history answers the question that
   * matters. See `describeLogin` in app/(modules)/bas/health-client.ts.
   */
  everCollected: boolean;
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
  /**
   * Station accounting, and the reason it has three numbers instead of two.
   *
   * B7.2 shipped `{ rendered, inDatabase }` and turned the screen red when they
   * disagreed, to catch a bad join silently dropping stations. B7.6 adds
   * filtering, which hides stations ON PURPOSE - so a naive version of that
   * check fires every time somebody types in the search box, and a false alarm
   * is how people learn to ignore a real one.
   *
   *   rendered   - stations the assembled tree actually contains
   *   matched    - stations matching the active filters, counted by a SEPARATE
   *                query that does not go through the tree's joins or its
   *                assembly in TypeScript
   *   inDatabase - every station in scope, ignoring filters entirely
   *
   * RED is `rendered !== matched`, and only that. It still means what it always
   * meant: the tree produced fewer stations than the database says match, which
   * nobody asked for.
   *
   * `matched < inDatabase` is ordinary text - "showing 4 of 37" - because that
   * is a filter doing its job.
   *
   * `matched` is a separate query on purpose. Deriving it from the same rows
   * the tree was built from would make the check tautological, and the whole
   * point is an independent second opinion.
   */
  stationsAccountedFor: {
    rendered: number;
    matched: number;
    inDatabase: number;
    /** Whether any filter narrowed the result. Drives text, never colour. */
    filtered: boolean;
  };

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


/**
 * How a station's collection state is bucketed for filtering (B7.6).
 *
 * The thresholds are the same ones `describeActivity` colours by, and they are
 * shared rather than restated: a filter that disagreed with the badge beside it
 * would be worse than no filter.
 *
 *   collecting - a record within COLLECTING_WITHIN_HOURS
 *   stale      - has records, but older than that
 *   never      - no record has ever arrived for any of its points
 */
export type StationState = "collecting" | "stale" | "never";

/**
 * How a station is reached, as the Settings filter offers it.
 *
 * `unconfigured` is split out of `via_parent` deliberately (B7.6). In the data
 * it IS via_parent - the pair is connection_mode = 'via_parent' with no
 * parent_station_id - but as a filter the two mean completely different things.
 * "Via parent" is a category; "discovered, unassigned" is a WORK QUEUE, the
 * stations nobody has finished configuring, and at scale that is the one people
 * reach for. Burying it inside a category nobody needs to filter by would hide
 * the only actionable list of the three.
 */
export type StationModeFilter = "direct" | "via_parent" | "unconfigured";
export type CredentialFilter = "set" | "unset";

/** Newest record inside this many hours counts as collecting. */
export const COLLECTING_WITHIN_HOURS = 2;

export interface BasSettingsFilters {
  /**
   * Free text over project name, building name, station display name, Niagara
   * station name and base URL.
   *
   * base_url is in there because somebody will paste "196.1.1" to find a
   * station by its address, which is how the one station anybody can name is
   * actually identified in conversation.
   */
  q: string;
  mode: StationModeFilter | null;
  state: StationState | null;
  credential: CredentialFilter | null;
}

export const NO_SETTINGS_FILTERS: BasSettingsFilters = {
  q: "",
  mode: null,
  state: null,
  credential: null,
};

export function settingsFiltersActive(f: BasSettingsFilters): boolean {
  return (
    f.q.trim().length > 0 ||
    f.mode !== null ||
    f.state !== null ||
    f.credential !== null
  );
}


/**
 * Whether the station count is a genuine problem, or a filter doing its job.
 *
 * A pure function, and separate from the component, because it is the rule
 * B7.6 most needed to get right and a rule that can only be checked by
 * rendering a screen is a rule nobody checks.
 *
 * `alarm` is `rendered !== matched` and NOTHING else. Both numbers are counted
 * after the same filter, one by assembling the tree and one by a separate
 * query, so a disagreement means the assembly lost stations nobody asked it to
 * lose. Comparing against `inDatabase` instead is the bug this exists to
 * prevent: it would fire on every keystroke in the search box.
 *
 * At the current schema a genuine mismatch is unreachable - every join the tree
 * walks is backed by a NOT NULL foreign key - so this is defence against a
 * future change that relaxes one, and it is checked at this level because it
 * cannot be provoked through the database.
 */
export interface StationCounts {
  rendered: number;
  matched: number;
  inDatabase: number;
  filtered: boolean;
}

export function settingsCountState(counts: StationCounts): {
  alarm: boolean;
  hiding: boolean;
} {
  return {
    alarm: counts.rendered !== counts.matched,
    hiding: counts.filtered && counts.matched !== counts.inDatabase,
  };
}

// ---------------------------------------------------------------------------
// Points (B8.2) - the level below Station in the Settings tree. Read-only.
// ---------------------------------------------------------------------------

/**
 * One point as the Settings Points list shows it.
 *
 * THE TRAP, named here because this is where a reader meets both columns:
 * `niagaraDisplayName` is bas_points.display_name, which is what NIAGARA calls
 * the history. bas_stations.display_name means the opposite - a person's name
 * for the station - and SettingsStation.displayName is that one. A person's
 * name for a POINT is `label`. Read the column comments the B8.1 migration
 * added before touching either.
 */
export interface SettingsPoint {
  pointId: string;
  /** What a person typed. Null for most rows today. Nothing edits it until B8.4. */
  label: string | null;
  /** The oBIX key, verbatim, $-hex escapes and all. Never editable, by anyone. */
  niagaraHistoryName: string;
  /** What the STATION calls it - bas_points.display_name. Refreshed by every discover. */
  niagaraDisplayName: string | null;
  pointRole: string | null;
  /** The vocabulary's wording for the role, when the point has one. */
  roleName: string | null;
  equipmentName: string | null;
  unit: string | null;
  /**
   * is_active: whether the collector FETCHES this point. Off is permanent in
   * effect. Why it is off is `inactiveReason`, when somebody recorded one.
   */
  collected: boolean;
  /**
   * Why, when `collected` is false. Null means not recorded, and the screen
   * says exactly that rather than guessing. Always null when collected is
   * true - the database refuses otherwise.
   */
  inactiveReason: InactiveReason | null;
  /** From bas_sync_checkpoints. Null when the collector has never passed this point. */
  completeness: Completeness | null;
  /**
   * The roll horizon as bas_v_collection_health states it, in the same three
   * distinct states Collection Health shows. A point on a station attached to
   * no building has no view row and reads unknown.
   */
  horizon: PointHorizon;
  lastRecordAt: string | null;
  /** is_visible. Shown and not editable until B8.3, and NEVER filtered on here. */
  visible: boolean;
}

/**
 * Point accounting, two numbers.
 *
 *   rendered    - rows the list query returned
 *   inDatabase  - bas_points WHERE station_id = ?, counted with no joins at all
 *
 * The list walks LEFT JOINs to equipment, role and checkpoint. If one of them
 * is ever made inner, or a future join drops a row, the two disagree and the
 * screen says so. Two numbers rather than the stations' three because nothing
 * filters this list - B8.3 made `visible` editable here and deliberately kept
 * hidden points ON this list, so there is no `matched` to carry. The day
 * something does filter it, add `matched` the way B7.6 did, or the alarm
 * fires on every hide.
 */
export interface PointCounts {
  rendered: number;
  inDatabase: number;
}

export interface StationPointsList {
  stationId: string;
  points: SettingsPoint[];
  pointsAccountedFor: PointCounts;
}

/** RED is the list holding fewer points than the database says the station has. */
export function pointsCountState(counts: PointCounts): { alarm: boolean } {
  return { alarm: counts.rendered !== counts.inDatabase };
}


/**
 * What the screen must say when a filter is hiding a problem (B7.6).
 *
 * A pure function, and separate from the component for the same reason
 * `settingsCountState` is: this is the rule the phase most needed to get right,
 * and a rule that can only be checked by rendering a screen is a rule nobody
 * checks.
 *
 * The danger is not that the tiles are wrong. They are right - they count the
 * filtered set, which is what was asked for. The danger is somebody filtering
 * to one building, reading "0 at risk", and concluding nothing anywhere is at
 * risk. One of this project's three outages sat unnoticed in the database for
 * eight days.
 *
 * So: whenever the unfiltered estate has more at-risk points than the filtered
 * view does, the screen says so. Including - especially - when the filtered
 * number is zero, which is the case that reads as all-clear.
 */
export function describeHiddenRisk(health: {
  totals: { pointsAtRisk: number; hiddenPointsAtRisk: number };
  unfiltered: UnfilteredTotals | null;
  scope: BasScope;
}): string | null {
  // Two ways a problem leaves the screen, one sentence each, same shape. A
  // filter (B7.6) removes it from the tiles AND the table; hiding (B8.3)
  // removes it from the table only. Both can be true at once.
  const sentences = [describeFilteredRisk(health), describeHiddenPointRisk(health)].filter(
    (sentence): sentence is string => sentence !== null,
  );
  return sentences.length === 0 ? null : sentences.join(" ");
}

function describeFilteredRisk(health: {
  totals: { pointsAtRisk: number };
  unfiltered: UnfilteredTotals | null;
  scope: BasScope;
}): string | null {
  const { unfiltered, scope } = health;
  if (unfiltered === null || !scope.filtered) return null;

  const hidden = unfiltered.pointsAtRisk - health.totals.pointsAtRisk;
  if (hidden <= 0) return null;

  const where = scope.label === null ? "this filter" : scope.label;

  return health.totals.pointsAtRisk === 0
    ? `No points are at risk in ${where}, but ${hidden} ${
        hidden === 1 ? "is" : "are"
      } at risk elsewhere. Clear the filter to see ${
        hidden === 1 ? "it" : "them"
      }.`
    : `${hidden} more ${
        hidden === 1 ? "point is" : "points are"
      } at risk outside ${where}.`;
}

/**
 * The same rule for a point somebody HID (B8.3). The tiles still count it -
 * hiding changes nothing about collection - but the table under them does not
 * draw it, so "1 at risk" over a table with no at-risk row reads as a screen
 * that has lost count, and "0 at risk listed" would read as all-clear. The
 * zero case is spelled out for the same reason it is in the filter sentence.
 */
function describeHiddenPointRisk(health: {
  totals: { pointsAtRisk: number; hiddenPointsAtRisk: number };
}): string | null {
  const hidden = health.totals.hiddenPointsAtRisk;
  if (hidden <= 0) return null;

  const listed = health.totals.pointsAtRisk - hidden;

  return listed === 0
    ? `No points at risk are listed in the table below, but ${hidden} hidden ${
        hidden === 1 ? "point is" : "points are"
      } at risk. Hidden points are still collected and still counted above; show ${
        hidden === 1 ? "it" : "them"
      } again under Settings → Points.`
    : `${hidden} more ${
        hidden === 1 ? "point is" : "points are"
      } at risk but hidden from the table below.`;
}

/**
 * The suffix every tile carries while a filter is active.
 *
 * "0 at risk" and "0 at risk in Liberty Center" are different claims, and only
 * one of them is true. Empty string when nothing is filtered, so the unfiltered
 * screen reads exactly as it did before.
 */
export function scopeSuffix(scope: BasScope): string {
  return scope.filtered && scope.label !== null ? ` in ${scope.label}` : "";
}
