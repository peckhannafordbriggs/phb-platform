
/**
 * Value plausibility (2026-09-28): does the data mean anything?
 *
 * Every other check on Collection Health asks whether data is ARRIVING - on
 * time, complete, within the horizon. None asked whether it means anything,
 * and two dead sensors sat green on every screen for a month:
 *
 *   points_RoomT (lab)                read 76 F, then -40 F at 09:05 on
 *                                     24 August, and exactly -40 for every
 *                                     reading since. -40 is what a Niagara
 *                                     analog input reports open-circuit.
 *   VAV-8 104-105_ZoneTemperature     exactly 70.5 for its entire history,
 *   (office)                          one distinct value in 1,626 readings.
 *
 * Both arrived on time, complete, no gaps. Both are worthless.
 *
 * THE ONE CHECK. A point whose value has not changed when it should have.
 * That catches both: a step followed by a flat line has the same signature
 * as a flat line. There is NO list of bad values - -40 is a real temperature
 * somewhere, and a hard-coded list is a guess dressed as a fact. The evidence
 * is the flatness, not the number.
 *
 * WHAT DECIDES WHETHER ANYONE USES THIS. A check that flags every setpoint is
 * worse than no check: people learn to ignore it and miss the real one. So
 * which points are judged, and how long they may hold still, comes from the
 * point's ROLE - specifically from the role's `measurement` kind and its
 * `is_setpoint` flag in bas_point_roles - and from nothing else:
 *
 *   - A point with no role is NOT checked, and says so. The lab's Temp1,
 *     Temp2 and Temp3 are deliberately unclassified because nobody knows
 *     what they are, and guessing would undo that.
 *   - A setpoint is not checked. A setpoint holding still is the setpoint
 *     working.
 *   - A status, command or mode point (`measurement` of status or mode) is
 *     not checked. Occupied has 419 records in two and a half years. That is
 *     normal.
 *   - A measured quantity - temperature, pressure, flow, humidity, a damper
 *     position, a fan speed - is checked against a threshold for its KIND,
 *     in PLAUSIBILITY_THRESHOLDS below, because a real measurement always
 *     moves a little, and how much "a little" is depends on what is measured.
 *
 * The SQL that selects which points to evaluate (plausibility-sql.ts, kept
 * apart because this file reaches the browser bundle) is GENERATED from the same
 * table (`checkedRoleSql`), so the two languages cannot hold two lists, and
 * tests/bas-plausibility.test.ts walks the whole role vocabulary through
 * both and fails if they disagree on any role.
 *
 * CHANGE-OF-VALUE TRENDS. An interval trend records a value every N seconds,
 * so "stuck" is a run of identical readings. A change-of-value trend records
 * only when the value changes, so "stuck" is NO NEW READINGS - the value is,
 * by the trend's own definition, unchanged since its last record. For those
 * the flat span runs from the last record to the collector's last SUCCESSFUL
 * pass over the point (bas_sync_checkpoints.last_run_at where last_status is
 * ok), because that pass is the proof that the station had nothing new. It
 * never runs to now(): a collector that has stopped is a collection fault,
 * reported by the roll-risk tile, and must not be mistaken for a dead sensor.
 * A point with no `collection_interval_s` recorded is treated as
 * change-of-value, which is what every such point on the live estate is
 * (see the add_bas_shortest_full_span migration); for an interval trend that
 * merely lacks its interval this is the conservative reading - the collector
 * asked and got repeats - and gives the same answer. On the live estate every
 * change-of-value point is a status or command point and so is not checked;
 * the path is proved by fixture.
 *
 * WHAT THIS NEVER DOES: deactivate a point, modify a reading, present a flag
 * as a confirmed fault, or remove a flagged point from any collection figure.
 * A flag is "this looks wrong, go and look". It is read-only end to end -
 * tests/bas-plausibility.test.ts reads this file, plausibility-sql.ts and the
 * query that carries them, and
 * refuses any write statement.
 *
 * COST. Computed on every page load, not stored, and that is a measurement
 * rather than a preference. Against the live table (82,478 readings, 7 MB) the
 * whole evaluation for 17 checked points ran in 6.5 ms over 589 shared
 * buffers. The plan walks BACKWARDS down the (point_id, ts) primary key and
 * stops at the first reading that differs, so a healthy point costs four
 * index probes whatever the table's size; only a dead sensor's run is walked
 * in full (7,547 rows for points_RoomT). LOOKBACK_DAYS bounds that walk so the
 * worst case - a sensor dead for a year - cannot make the screen slow exactly
 * when somebody needs it. Storing a verdict per collector pass would put the
 * logic in the other repository (phb-bas), need a migration, and go stale
 * whenever a threshold here changed; at 6.5 ms there is nothing to buy.
 * Revisit if the evaluation passes 200 ms on the live screen, measured with
 * the EXPLAIN in docs/bas-plausibility-verification.md, or the estate grows
 * past a few hundred checked points.
 */

// ---------------------------------------------------------------------------
// Thresholds
// ---------------------------------------------------------------------------

export interface PlausibilityThreshold {
  /** bas_point_roles.measurement, exactly. */
  measurement: string;
  /** A checked point flat for at least this long is flagged. */
  hours: number;
  /** Why this many, in words a technician can argue with. Shown on screen. */
  why: string;
}

/**
 * How long a measured quantity may hold one value before it looks stuck, by
 * the KIND of measurement. Not one number for everything: a zone temperature
 * flat for six hours is suspicious; a duct static pressure flat for six hours
 * is broken; a damper command flat for six hours is a Tuesday.
 *
 * Defended against the live estate on 2026-09-28 by measuring the LONGEST run
 * of identical readings in every checked point's whole history (the query is
 * in docs/bas-plausibility-verification.md). The healthy figures are quoted
 * beside each threshold. Every threshold sits well clear of the healthy
 * maximum for its kind, so the defaults do not fire on the data we have -
 * except where the record says they should.
 *
 * A measurement kind absent from this table is NOT checked (`no_threshold`),
 * never checked with a default. status and mode are absent on purpose: they
 * are state words, and a state holding still is the equipment doing what it
 * was told.
 */
export const PLAUSIBILITY_THRESHOLDS: readonly PlausibilityThreshold[] = [
  {
    measurement: "temperature",
    hours: 6,
    why:
      "A room, a duct or the outdoors drifts by more than a sensor's resolution " +
      "every few hours. The ten healthy office zones never held one value longer " +
      "than 1.8 h in 1,626 readings each; outside air never longer than 0.5 h.",
  },
  {
    measurement: "humidity",
    hours: 6,
    why: "Moves with temperature and occupancy on the same timescale as temperature.",
  },
  {
    measurement: "pressure",
    hours: 3,
    why:
      "A static or differential pressure moves with every fan and damper " +
      "adjustment. The office duct static never repeated a value more than twice " +
      "in a row in 3,045 readings. Six hours flat is broken; three is the alarm.",
  },
  {
    measurement: "flow",
    hours: 6,
    why: "An air or water flow reading carries the same turbulence a pressure does.",
  },
  {
    measurement: "concentration",
    hours: 6,
    why: "CO2 rises and falls with the people in the room, every working day.",
  },
  {
    measurement: "position",
    hours: 168,
    why:
      "A damper or valve COMMAND sits at its limit for as long as the strategy " +
      "keeps it there: the office outside-air damper held exactly 10 % for 9.4 " +
      "days in September. Hours mean nothing for an output; a week outlasts any " +
      "schedule, so an output that has not moved in a week has a loop that has " +
      "not run in a week.",
  },
  {
    measurement: "speed",
    hours: 168,
    why:
      "A fan or pump speed command is an output like a damper position: fixed " +
      "while the unit is off or at a constant-volume setting. A week, for the " +
      "same reason.",
  },
  {
    measurement: "current",
    hours: 24,
    why: "Electrical readings hold at zero while the equipment is off; a day covers any off cycle.",
  },
  {
    measurement: "power",
    hours: 24,
    why: "Same as current: zero while off, moving whenever anything runs.",
  },
  {
    measurement: "voltage",
    hours: 24,
    why: "Supply voltage wanders with load through the day; a day flat is a meter that has stopped.",
  },
  {
    measurement: "ratio",
    hours: 24,
    why: "A power factor moves with the load mix through the day.",
  },
  {
    measurement: "energy",
    hours: 168,
    why:
      "An accumulator advances whenever anything runs. A meter that has not " +
      "advanced in a week is broken, or the plant has been off for a week - either " +
      "is worth a look.",
  },
  { measurement: "volume", hours: 168, why: "An accumulator, as energy." },
  { measurement: "time", hours: 168, why: "Run hours accumulate; as energy." },
  { measurement: "count", hours: 168, why: "A start counter; as energy." },
];

/**
 * A checked point needs at least this many readings inside the lookback
 * window before it is judged at all, and an interval trend needs at least
 * this many IDENTICAL readings before a run is called flat. A point with
 * three readings is not stuck; it is new. Twelve is one hour at a
 * five-minute interval and three at fifteen, both under every threshold
 * above, so the guard never hides a point the threshold would flag.
 *
 * The window count is bounded at this number in SQL (a LIMIT inside the
 * count), so it costs at most twelve rows per point whatever the history.
 */
export const MIN_READINGS = 12;

/**
 * How far back from a point's newest reading the search for a different value
 * goes. Bounds the cost of walking a dead sensor's run (see the file comment);
 * past it the screen says "at least 90 days" rather than a false precise
 * figure. 90 days is longer than any threshold by a factor of twelve, so no
 * flag is missed - only its exact start.
 */
export const LOOKBACK_DAYS = 90;

export function thresholdFor(measurement: string | null): PlausibilityThreshold | null {
  if (measurement === null) return null;
  return PLAUSIBILITY_THRESHOLDS.find((t) => t.measurement === measurement) ?? null;
}

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

/**
 *   flat               held one value at least as long as its kind's threshold,
 *                      with enough readings to say so. "Go and look."
 *   moving             checked, and the value has changed inside the threshold.
 *   too_few_readings   checked, but fewer than MIN_READINGS - nothing to say yet.
 *   not_checked        the role says not to, or there is no role. Never a
 *                      guess: `notCheckedReason` says which.
 */
export type PlausibilityState = "flat" | "moving" | "too_few_readings" | "not_checked";

/**
 *   not_collected   is_active is false: the collector does not fetch it.
 *   no_role         point_role is NULL. "Not checked, role not set."
 *   setpoint        the role is a setpoint (bas_point_roles.is_setpoint).
 *   state           the role's measurement is status or mode: a status,
 *                   command or mode point.
 *   no_threshold    the role's measurement kind has no row in
 *                   PLAUSIBILITY_THRESHOLDS (the `unclassified` role has no
 *                   measurement at all).
 */
export type NotCheckedReason =
  | "not_collected"
  | "no_role"
  | "setpoint"
  | "state"
  | "no_threshold";

export const NOT_CHECKED_REASONS: readonly NotCheckedReason[] = [
  "not_collected",
  "no_role",
  "setpoint",
  "state",
  "no_threshold",
];

/** Measurement kinds that are state words rather than quantities. */
export const STATE_MEASUREMENTS: readonly string[] = ["status", "mode"];

/** interval: records every N seconds. cov: records on change only. */
export type TrendKind = "interval" | "cov";

/**
 * One reading's value. bas_readings holds at most one of the three columns
 * (bas_readings_at_most_one_value); a row with none is a record the station
 * logged with nothing in it, and a run of those is reported as flat at "no
 * value" - a point logging empties for hours is worth a look too.
 */
export interface ReadingValue {
  num: number | null;
  bool: boolean | null;
  str: string | null;
}

export interface PointPlausibility {
  state: PlausibilityState;
  notCheckedReason: NotCheckedReason | null;
  /** The role's measurement kind, when the point has a role. */
  measurement: string | null;
  /** The threshold applied, hours. Null when not checked. */
  thresholdHours: number | null;
  trendKind: TrendKind | null;
  /**
   * For an interval trend, the identical readings in the current run - the
   * "6,447 readings" figure. For a change-of-value trend, or for a point
   * judged to have too few readings, the readings in the lookback window,
   * counted no further than MIN_READINGS. Null when not checked.
   */
  readings: number | null;
  /** How long the value has been the same, hours. Null unless checked with readings. */
  flatHours: number | null;
  /** First reading of the current run - when the value became what it is. ISO UTC. */
  flatSince: string | null;
  /**
   * The last instant the value is KNOWN to have been the same: the newest
   * reading for an interval trend; for a change-of-value trend, the later of
   * the newest reading and the collector's last successful pass.
   */
  flatUntil: string | null;
  /** The value it is holding. Null when there is no reading at all. */
  value: ReadingValue | null;
  /** When it last read something else, and what. Null when it never has (see the two flags). */
  lastDifferentAt: string | null;
  lastDifferentValue: ReadingValue | null;
  /** No different value exists in the readings held: the run is the whole history. */
  runIsWholeHistory: boolean;
  /**
   * No different value inside LOOKBACK_DAYS of the newest reading, and the
   * history goes back further than that. `flatHours` is then a floor, not a
   * measurement: "at least 90 days".
   */
  lookbackExhausted: boolean;
}

/**
 * The columns `plausibilityLateral` adds to a row, all NULL when the point was
 * not evaluated. `pl_checked` is true exactly when it was.
 */
export interface PlausibilityFacts {
  pl_checked: boolean | null;
  pl_last_ts: Date | null;
  pl_value_num: number | null;
  pl_value_bool: boolean | null;
  pl_value_str: string | null;
  pl_diff_ts: Date | null;
  pl_diff_num: number | null;
  pl_diff_bool: boolean | null;
  pl_diff_str: string | null;
  /** Readings in the current run: newer than the last different reading, inside the lookback. */
  pl_run_readings: number | null;
  pl_flat_since: Date | null;
  pl_history_start: Date | null;
  /** Readings inside the lookback window, counted up to MIN_READINGS and no further. */
  pl_window_readings: number | null;
}
// ---------------------------------------------------------------------------
// The judge
// ---------------------------------------------------------------------------

/** What the judge needs from the point, its role and its checkpoint, beside the facts. */
export interface PlausibilityRow extends PlausibilityFacts {
  is_active: boolean;
  point_role: string | null;
  role_is_setpoint: boolean | null;
  role_measurement: string | null;
  collection_interval_s: number | null;
  /** bas_sync_checkpoints, LEFT-joined: null when the collector has never passed the point. */
  last_run_at: Date | null;
  last_status: string | null;
}

const HOUR_MS = 3_600_000;

function readingValue(num: number | null, bool: boolean | null, str: string | null): ReadingValue {
  return { num, bool, str };
}

/**
 * Applies the thresholds to the facts. Pure, so every rule in the file
 * comment is a unit test.
 *
 * The role decision is repeated here in TypeScript only to WORD the
 * not-checked reason; the decision itself is `checkedRoleSql`, which is what
 * chose whether `pl_checked` is set. If the two ever disagree this throws
 * rather than guessing, and tests/bas-plausibility.test.ts walks every role
 * in the vocabulary through both to keep that unreachable.
 */
export function judgePlausibility(row: PlausibilityRow): PointPlausibility {
  const none: PointPlausibility = {
    state: "not_checked",
    notCheckedReason: null,
    measurement: row.role_measurement,
    thresholdHours: null,
    trendKind: null,
    readings: null,
    flatHours: null,
    flatSince: null,
    flatUntil: null,
    value: null,
    lastDifferentAt: null,
    lastDifferentValue: null,
    runIsWholeHistory: false,
    lookbackExhausted: false,
  };

  const notChecked = (reason: NotCheckedReason): PointPlausibility => {
    if (row.pl_checked === true) {
      throw new Error(
        `plausibility: SQL evaluated a point TypeScript would not check (${reason}, ` +
          `role ${row.point_role ?? "null"}, measurement ${row.role_measurement ?? "null"})`,
      );
    }
    return { ...none, notCheckedReason: reason };
  };

  if (!row.is_active) return notChecked("not_collected");
  if (row.point_role === null) return notChecked("no_role");
  if (row.role_is_setpoint === true) return notChecked("setpoint");
  if (row.role_measurement !== null && STATE_MEASUREMENTS.includes(row.role_measurement)) {
    return notChecked("state");
  }
  const threshold = thresholdFor(row.role_measurement);
  if (threshold === null) return notChecked("no_threshold");

  if (row.pl_checked !== true) {
    throw new Error(
      `plausibility: SQL did not evaluate a point TypeScript expected to check ` +
        `(role ${row.point_role}, measurement ${row.role_measurement})`,
    );
  }

  const trendKind: TrendKind = row.collection_interval_s === null ? "cov" : "interval";
  const windowReadings = row.pl_window_readings ?? 0;

  const checked = {
    ...none,
    thresholdHours: threshold.hours,
    trendKind,
    readings: windowReadings,
  };

  // Not enough history to judge at all: a new point, or one that has barely
  // reported. Says how many, out of how many it needs.
  if (
    row.pl_last_ts === null ||
    row.pl_flat_since === null ||
    windowReadings < MIN_READINGS
  ) {
    return { ...checked, state: "too_few_readings" };
  }

  // An interval trend's evidence is the run itself. A change-of-value trend's
  // run is one record by definition, so its evidence is the window count.
  const readings = trendKind === "interval" ? (row.pl_run_readings ?? 0) : windowReadings;

  const value = readingValue(row.pl_value_num, row.pl_value_bool, row.pl_value_str);

  // Where the value is KNOWN to still be the same. An interval trend: its
  // newest reading. A change-of-value trend: also the collector's last
  // successful pass, which is the station saying "nothing new" - and never
  // now(), because a stopped collector is the roll-risk tile's fault to
  // report, not this check's.
  const lastOkRun =
    row.last_status === "ok" && row.last_run_at !== null ? row.last_run_at : null;
  const flatUntil =
    trendKind === "cov" && lastOkRun !== null && lastOkRun > row.pl_last_ts
      ? lastOkRun
      : row.pl_last_ts;

  const flatHours = (flatUntil.getTime() - row.pl_flat_since.getTime()) / HOUR_MS;

  const lookbackStart = row.pl_last_ts.getTime() - LOOKBACK_DAYS * 24 * HOUR_MS;
  const lookbackExhausted =
    row.pl_diff_ts === null &&
    row.pl_history_start !== null &&
    row.pl_history_start.getTime() < lookbackStart;
  const runIsWholeHistory = row.pl_diff_ts === null && !lookbackExhausted;

  // Past the threshold on span but thin on evidence - an interval trend whose
  // identical readings straddle a collection gap - is not called flat either.
  const state: PlausibilityState =
    flatHours < threshold.hours
      ? "moving"
      : readings < MIN_READINGS
        ? "too_few_readings"
        : "flat";

  return {
    ...checked,
    readings,
    state,
    flatHours,
    flatSince: row.pl_flat_since.toISOString(),
    flatUntil: flatUntil.toISOString(),
    value,
    lastDifferentAt: row.pl_diff_ts?.toISOString() ?? null,
    lastDifferentValue:
      row.pl_diff_ts === null
        ? null
        : readingValue(row.pl_diff_num, row.pl_diff_bool, row.pl_diff_str),
    runIsWholeHistory,
    lookbackExhausted,
  };
}

// ---------------------------------------------------------------------------
// What Collection Health carries
// ---------------------------------------------------------------------------

/** One flagged point, by name, as the card lists it. `plausibility.state` is always `flat`. */
export interface FlatPoint {
  pointId: string;
  pointName: string;
  siteName: string;
  stationName: string;
  unit: string | null;
  /**
   * bas_points.is_visible. Carried so the card can SAY a flagged point is
   * hidden from the browsing screens; it is listed either way. Hiding never
   * removes a point from a figure (B8.3), and this card is a figure.
   */
  visible: boolean;
  plausibility: PointPlausibility;
}

export interface PlausibilitySummary {
  /** Active points in scope the check evaluated (flat + moving + too few readings). */
  checked: number;
  moving: number;
  tooFewReadings: number;
  /** Active points in scope NOT evaluated, by reason. `not_collected` is always 0 here: inactive points are outside every active figure. */
  notChecked: Record<NotCheckedReason, number>;
  /** Every flagged point in scope, hidden ones included, worst (longest flat) first. */
  flat: FlatPoint[];
}

export function emptyNotChecked(): Record<NotCheckedReason, number> {
  return { not_collected: 0, no_role: 0, setpoint: 0, state: 0, no_threshold: 0 };
}

/** A not-checked verdict with every fact null. For fixtures that build a SettingsPoint by hand. */
export function notCheckedPlausibility(reason: NotCheckedReason): PointPlausibility {
  return {
    state: "not_checked",
    notCheckedReason: reason,
    measurement: null,
    thresholdHours: null,
    trendKind: null,
    readings: null,
    flatHours: null,
    flatSince: null,
    flatUntil: null,
    value: null,
    lastDifferentAt: null,
    lastDifferentValue: null,
    runIsWholeHistory: false,
    lookbackExhausted: false,
  };
}
