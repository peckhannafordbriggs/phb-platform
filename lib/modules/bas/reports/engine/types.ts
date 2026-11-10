import type { LibrarySection } from "../library";

/**
 * The shapes the report engine (Reports, Phase 2) passes between its parts
 * and stores on a run. Every number a report shows is in one of these; the
 * model's prose is two sentences on a Finding and one on a section, and the
 * renderer never takes a number from either.
 */

export type Priority = "watch" | "action_needed";
export type FindingState = "new" | "still_open" | "cleared";
export type SectionStatus = "good" | "watch" | "action_needed";
export type QuestionOutcome = "answered" | "not_applicable" | "not_monitored" | "not_run";
export type RunStatus = "queued" | "running" | "succeeded" | "partial" | "failed";

/** A half-open interval of UTC milliseconds. */
export interface Interval {
  start: number;
  end: number;
}

/**
 * The numbers behind a finding, as the report shows them. `actual` and
 * `expected` are already worded with their unit ("77.8 °F", "within ±2 °F of
 * 72.0 °F"); `duration` or `percent` says how long or how often; `when` says
 * when (a time of day, a date, "since 24 Aug"). Extra keys carry the raw
 * numbers for a table.
 */
export interface Evidence {
  actual: string;
  expected: string;
  duration?: string;
  percent?: number;
  when: string;
  [extra: string]: unknown;
}

export interface Finding {
  questionKey: string;
  section: LibrarySection;
  /** `equipment:<id>` or `point:<id>`. */
  subjectKey: string;
  equipmentId: string | null;
  subjectName: string;
  issueCode: string;
  /** The issue in a few words: "Starved for air", "Flat-lined". */
  issue: string;
  priority: Priority;
  evidence: Evidence;
  /** Set by the comparison. */
  fingerprint: string;
  state: FindingState;
  firstSeenRunId: string | null;
  firstSeenAt: string | null;
  /** Set by the narrative, or left null. */
  likelyCause: string | null;
  recommendedAction: string | null;
  fixLocation: "site" | "remote" | null;
}

/** A finding before the comparison and the narrative have run. */
export type RawFinding = Omit<
  Finding,
  "fingerprint" | "state" | "firstSeenRunId" | "firstSeenAt" | "likelyCause" | "recommendedAction" | "fixLocation"
>;

/** One point's readings over the period, sample-and-hold. */
export interface PointSeries {
  pointId: string;
  /** The shown name: label, Niagara's name, or the oBIX key. */
  name: string;
  role: string | null;
  measurement: string | null;
  isSetpoint: boolean;
  isStatus: boolean;
  isCommand: boolean;
  unit: string | null;
  dataType: string;
  equipmentId: string | null;
  equipmentName: string | null;
  stationId: string;
  /** Declared interval, seconds; null is a change-of-value trend. */
  intervalS: number | null;
  /** Fraction of the period covered, 0..1, from the SQL. */
  coverage: number;
  /** The value at the period start, from the last reading before it. */
  carryIn: number | null;
  carryInAt: number | null;
  samples: Array<{ t: number; v: number }>;
  /** Readings in the period before downsampling. */
  readingCount: number;
  /** Recorded gaps inside the period. */
  gaps: Interval[];
  /** When a bucket averaged several readings, how wide it was; null means raw. */
  bucketMs: number | null;
}

export interface EquipmentUnit {
  equipmentId: string;
  name: string;
  equipType: string | null;
  parentEquipmentId: string | null;
  points: PointSeries[];
  roles: Set<string>;
  /** Jim's Step 1, from the roles present. */
  hydronic: boolean;
  dx: boolean;
  stagedHeat: boolean;
  economizer: boolean;
  reheat: boolean;
}

export type OccupancyKind = "point" | "manual" | "none";

export interface OccupancySource {
  stationId: string;
  stationName: string;
  kind: OccupancyKind;
  /** Occupied intervals in the period, or null when there is no source. */
  intervals: Interval[] | null;
  detail: string;
}

export interface ZoneResult {
  equipmentId: string;
  name: string;
  /** Occupied minutes with both temperature and setpoint known. */
  judgedMinutes: number;
  inBandMinutes: number;
  percentInBand: number | null;
  maxDeviationF: number | null;
  /** The hour of day, local, with the most out-of-band minutes; null when none. */
  worstHour: number | null;
  setpointKind: "single" | "dual" | "missing";
}

export interface ScheduleResult {
  equipmentId: string;
  name: string;
  statusPoint: string;
  hoursOutside: number;
  days: number;
}

export interface QuestionResult {
  key: string;
  position: number;
  section: LibrarySection;
  text: string;
  kind: "computed" | "planner";
  outcome: QuestionOutcome;
  /** For not_monitored: the spec's labels for the missing requirements. */
  missing: string[];
  /** For not_applicable or not_run: why, in words. */
  reason: string | null;
  /** Equipment the question ran over, by name. */
  equipment: string[];
  /** Equipment that was skipped and why - a coverage shortfall on one unit, say. */
  skipped: Array<{ name: string; reason: string }>;
  /** Section-specific figures the renderer draws tables from. */
  metrics: Record<string, unknown>;
}

export interface SectionDocument {
  key: LibrarySection;
  label: string;
  status: SectionStatus | "not_applicable" | "not_monitored" | "not_run";
  /** Code's sentence when there is nothing to say, the model's when there is. */
  statusSentence: string;
  questions: QuestionResult[];
  findings: Finding[];
}

export interface ReportHeader {
  definitionName: string;
  presetLabel: string | null;
  buildingName: string;
  stationNames: string[];
  periodStart: string;
  periodEnd: string;
  timezone: string;
  windowLabel: string;
  outdoor: { avgF: number; highF: number; lowF: number; pointName: string } | null;
  generatedAt: string;
  status: RunStatus;
  partialReason: string | null;
}

export interface InventoryDocument {
  equipmentTypesFound: string[];
  requiredPointsFound: number;
  requiredPointsTotal: number;
  lowCoverage: Array<{ name: string; coverage: number }>;
  notMonitored: Array<{ position: number; key: string; text: string; missing: string[] }>;
  notApplicable: Array<{ position: number; key: string; text: string; reason: string }>;
  occupancy: Array<{ stationName: string; kind: OccupancyKind; detail: string }>;
  pointsInScope: number;
  equipmentInScope: number;
}

export interface SummaryDocument {
  status: SectionStatus;
  topFindings: Finding[];
  counts: { new: number; stillOpen: number; cleared: number };
  siteVisit: string[];
  remoteFix: string[];
}

export interface ReportDocument {
  version: 1;
  header: ReportHeader;
  inventory: InventoryDocument;
  summary: SummaryDocument;
  sections: SectionDocument[];
  /** Cleared since the previous run, with the previous run's evidence. */
  cleared: Finding[];
  /** Action Needed items still open, oldest first. */
  carriedForward: Finding[];
  /** Custom questions, which this phase does not run. */
  plannerQuestions: Array<{ text: string; note: string }>;
  cost: { inputTokens: number; outputTokens: number; costUsd: number; budgetUsd: number; model: string | null; calls: number };
}
