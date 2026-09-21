/**
 * The vocabulary of the Analyze tab (B5): a question in, one of five answers
 * out.
 *
 * Read docs/BAS-B5.md before changing any of this. The whole feature is judged
 * on one test: does a wrong or partial answer LOOK DIFFERENT from a right one.
 * Every field here exists to make one of those differences visible, and the
 * union is deliberately not `{ answer: string }` with optional extras - a
 * component that receives a `no_data` result cannot render it as a sentence,
 * because there is no sentence to render.
 *
 * Nothing here comes from the model unlabelled. `answer` and `interpretation`
 * are the model's words and are named as such; everything under `provenance`
 * is computed by this platform from the rows and the database, after the query
 * has run, and the model has no way to alter it.
 */

/** A cell as it crosses to the browser. `bigint`, `numeric` and dates arrive as strings. */
export type Cell = string | number | boolean | null;

export interface ResultTable {
  columns: string[];
  rows: Cell[][];
  /** Rows actually returned, AFTER the cap. */
  rowCount: number;
  /** The query had more rows than `rowCap`; what is shown is the first `rowCap`. */
  truncated: boolean;
  rowCap: number;
}

export interface TimeRange {
  /** ISO 8601, UTC. */
  start: string;
  end: string;
}

export interface ProvenancePoint {
  id: string;
  /** What a person calls it: label, else the Niagara display name, else the history name. */
  name: string;
  site: string;
  station: string;
  /** False when the collector is not fetching this point. */
  collected: boolean;
}

export interface GapOverlap {
  pointId: string;
  pointName: string;
  /** The intersection with the queried range, not the whole gap. */
  start: string;
  end: string;
  hours: number;
  cause: string;
}

/**
 * How the points in scope were determined.
 *
 *   declared    the planner named the point ids its SQL reads, and every one
 *               of them exists
 *   all_points  the SQL reads bas_readings but the planner named no points, so
 *               the gap figure below is over EVERY point - a superset, which
 *               over-reports rather than under-reports
 *   none        the SQL does not read readings at all (a question about
 *               stations, gaps, runs, vocabulary), so gap overlap is moot
 */
export type ScopeSource = "declared" | "all_points" | "none";

export interface Provenance {
  /** The range the planner resolved "last week" to, in UTC. Null when the SQL has no time filter. */
  timeRange: TimeRange | null;
  scope: ScopeSource;
  points: ProvenancePoint[];
  /**
   * Gap overlap, computed here from bas_data_gaps. Null ONLY when it could not
   * be computed - the SQL reads readings but no time range was declared - and
   * the screen says so in amber rather than showing nothing.
   */
  gaps: {
    /** Hours of the range with no readings, after overlapping records are merged. */
    totalHours: number;
    /** One entry per distinct interval per point, after merging. */
    items: GapOverlap[];
    /**
     * Recorded rows that overlapped another row for the same point and were
     * merged into it. Non-zero means bas_data_gaps holds duplicates - on
     * 2026-09-21 the collector had recorded one outage twice, a day apart,
     * because a pass recorded the gap and then failed before advancing the
     * checkpoint. The total above is right regardless; this says why the
     * row count on Collection Health is higher.
     */
    mergedRows: number;
  } | null;
  /** Points in scope whose roll horizon is unknown (`horizon_state = 'unknown'`). */
  unknownHorizon: { count: number; names: string[] };
  /**
   * What the database actually holds for the points in scope. Null when no
   * points are in scope or the query reads no readings.
   */
  coverage: {
    earliest: string | null;
    latest: string | null;
    readings: number;
    /** Points in scope with no readings at all, by name. */
    neverCollected: string[];
  } | null;
  /**
   * The SQL selected by role, and points with no role exist. Those points are
   * silently outside the answer, and the screen says so.
   */
  unclassifiedExcluded: number;
  /**
   * The SQL filters by time (now(), interval, a timestamp column) but the
   * plan declared no time range, even after being asked once more. `gaps`
   * is then null for a reason the screen has to give: not "does not apply"
   * but "the period was not stated, so the overlap could not be checked".
   * Found live on 2026-09-21 with `now() - interval '30 days'` and a null
   * range beside it.
   */
  periodUndeclared: boolean;
  /**
   * The declared range is not covered by the readings held: it begins before
   * the first reading, ends after the last, or both. A sentence, computed
   * here, or null when the range is covered or nothing can be compared.
   * Found live on 2026-09-21: "72.73 °F over the last 30 days" over readings
   * spanning ten of them, and only the model happened to mention it. An
   * average labelled with a period it does not cover is the most dangerous
   * sentence this tab can produce, so the platform says it every time.
   */
  coverageShortfall: string | null;
}

export interface Attempt {
  sql: string;
  /** What went wrong, in the database's or the guard's words. */
  error: string;
}

/**
 * Why a result carries no data even though the query ran.
 *
 *   no_rows      the query returned zero rows
 *   all_null     it returned rows, but every cell is NULL - an aggregate over
 *                nothing, e.g. `avg()` with no matching readings, which looks
 *                like one row and means the same as no rows
 */
export type NoDataReason = "no_rows" | "all_null";

export type AnalyzeResult =
  /** ANTHROPIC_API_KEY or BAS_ASK_DATABASE_URL is not set. The rest of BAS works. */
  | { kind: "not_configured"; missing: string[] }
  /** The planner needs a decision from the person before it can write SQL. */
  | { kind: "clarify"; question: string; interpretation: string }
  /**
   * The planner could not write valid SQL, the SQL was refused by the guard or
   * the database, or the model declined. `attempts` is every SQL that was tried,
   * in order, so the person can see what it did rather than take its word.
   */
  | {
      kind: "cannot_answer";
      reason: string;
      attempts: Attempt[];
      retried: boolean;
    }
  /**
   * The query ran and matched nothing. NOT an answer of zero. The summariser is
   * never invoked for this result - there is nothing to summarise, and a model
   * asked to summarise nothing produces a plausible sentence about zero.
   */
  | {
      kind: "no_data";
      reason: NoDataReason;
      /** Computed here from coverage: "readings run from X to Y; you asked about Z". */
      explanation: string;
      sql: string;
      interpretation: string;
      table: ResultTable;
      provenance: Provenance;
      durationMs: number;
      retried: boolean;
    }
  | {
      kind: "answered";
      /** The model's reading of the rows. Labelled as such on screen. */
      answer: string;
      /** The model's one-sentence account of how it read the question. */
      interpretation: string;
      sql: string;
      table: ResultTable;
      provenance: Provenance;
      durationMs: number;
      /** The first plan was unusable and a second was requested. Said on screen. */
      retried: boolean;
    };

/**
 * What the planner returns. Its SQL is not trusted - it is guarded, then run
 * on a role that cannot write. Its `timeRange` and `pointIds` are declarations
 * the platform verifies against the database where it can and labels where it
 * cannot; see `Provenance.scope`.
 */
export type Plan =
  | {
      kind: "query";
      sql: string;
      timeRange: TimeRange | null;
      pointIds: string[];
      /** The SQL narrows by `point_role`. Unclassified points are then outside it. */
      filtersByRole: boolean;
      interpretation: string;
    }
  | { kind: "clarify"; question: string; interpretation: string }
  | { kind: "cannot_answer"; reason: string };

/** Thrown by a planner when the model is unusable: refusal, no parse, transport. */
export class PlannerError extends Error {
  constructor(
    readonly code: "refused" | "unparseable" | "unavailable",
    message: string,
  ) {
    super(message);
    this.name = "PlannerError";
  }
}
