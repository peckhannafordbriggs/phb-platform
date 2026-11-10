import type { LibraryQuestionKind, RoleRequirement } from "./library";
import type { PresetKey } from "./presets";
import type { AnalysisWindow, ScheduleSpec } from "./schedule";

/**
 * What the Reports screens receive (Phase 1). Every id is a string: the
 * tables key on bigint, and a bigint through JSON is a number that rounds.
 */

export const REPORT_STATES = ["draft", "active", "paused", "paused_owner_disabled"] as const;
export type ReportState = (typeof REPORT_STATES)[number];

export function isReportState(value: string): value is ReportState {
  return (REPORT_STATES as readonly string[]).includes(value);
}

/** The state in the list's words. */
export const REPORT_STATE_LABELS: Record<ReportState, string> = {
  draft: "Draft",
  active: "Active",
  paused: "Paused",
  paused_owner_disabled: "Paused — owner disabled",
};

export type ReportQuestionKind = "library" | "personal" | "inline";

export interface ReportSummary {
  reportId: string;
  name: string;
  description: string | null;
  ownerEmployeeId: string;
  ownerName: string;
  ownerEmail: string;
  /** Whether the viewer owns it. An admin sees every report; this says which are theirs. */
  isOwner: boolean;
  site: { siteId: string; name: string; timezone: string };
  /** Stations the report covers: 0 selected means every station on the building. */
  stationsSelected: number;
  stationsOnSite: number;
  presetKey: PresetKey | null;
  presetLabel: string | null;
  analysisWindow: AnalysisWindow;
  /** Null when the stored parameters could not be read as the kind's shape. */
  schedule: ScheduleSpec | null;
  timeOfDay: string;
  /** "Every Monday at 06:00 (America/New_York) · last 7 days", or a plain statement that the schedule is unreadable. */
  scheduleText: string;
  nextRunAt: string | null;
  state: ReportState;
  questionCount: number;
  /** ADDITIONAL recipients. The owner is not counted: the owner is not a row. */
  recipientCount: number;
  /** Always null in Phase 1. There are no runs. */
  lastRun: null;
  budgetUsd: number;
  createdAt: string;
  updatedAt: string;
}

export interface ReportQuestionView {
  questionId: string;
  position: number;
  kind: ReportQuestionKind;
  text: string;
  libraryQuestionId: string | null;
  libraryKey: string | null;
  section: string | null;
  sectionLabel: string | null;
  libraryKind: LibraryQuestionKind | null;
  appliesToLabel: string | null;
  personalQuestionId: string | null;
}

export interface RecipientView {
  email: string;
  isExternal: boolean;
  confirmedAt: string | null;
  addedBy: string | null;
  createdAt: string;
}

export interface ReportStationOption {
  stationId: string;
  name: string;
  selected: boolean;
}

export interface ReportDetail extends ReportSummary {
  stationIds: string[];
  stations: ReportStationOption[];
  questions: ReportQuestionView[];
  recipients: RecipientView[];
}

export interface ReportsList {
  reports: ReportSummary[];
  /**
   * Reports the viewer may see, counted with no joins, so the screen can say
   * in red when the list lost one - the same guard the Projects cards carry.
   */
  reportsInDatabase: number;
  canAdminister: boolean;
  viewerEmployeeId: string;
}

export interface LibraryQuestionView {
  libraryQuestionId: string;
  key: string;
  section: string;
  sectionLabel: string;
  position: number;
  text: string;
  kind: LibraryQuestionKind;
  analysisFn: string | null;
  appliesToLabel: string;
  appliesToEquipment: string[];
  requiredRoles: RoleRequirement[];
  /** The requirement labels joined, for a screen. */
  requiredRolesText: string;
  minCoverage: number;
  enabled: boolean;
  addedBy: string | null;
  createdAt: string;
}

export interface PersonalQuestionView {
  personalQuestionId: string;
  text: string;
  /** Reports of the viewer's that use it. */
  usedInReports: number;
  createdAt: string;
  updatedAt: string;
}

export interface ReportSiteOption {
  siteId: string;
  name: string;
  timezone: string;
  projectName: string;
  stations: Array<{ stationId: string; name: string }>;
}

/** What the editor needs before a report exists. */
export interface ReportOptions {
  sites: ReportSiteOption[];
  defaultBudgetUsd: number;
  companyEmailDomain: string;
}

/** The result of activate / pause / resume. */
export interface ReportStateChange {
  state: ReportState;
  nextRunAt: string | null;
}
