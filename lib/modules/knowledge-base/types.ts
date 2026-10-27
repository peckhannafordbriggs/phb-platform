/**
 * Closed vocabularies stored as text and enforced by CHECK constraints in the
 * KB migration. Each list here and its CHECK must agree; tests/kb-schema.test.ts
 * reads the CHECK back out of the catalog and compares. Change both together.
 */

/** How the projects for a question were chosen (kb_questions.scope_how). */
export const KB_SCOPE_HOW = ["all", "chosen", "from_question", "follow_up"] as const;
export type KbScopeHow = (typeof KB_SCOPE_HOW)[number];

/**
 * What kind of final answer a question got (kb_questions.answer_kind). Only
 * final answers are stored: a question that failed is not history.
 */
export const KB_ANSWER_KINDS = ["answered", "no_evidence"] as const;
export type KbAnswerKind = (typeof KB_ANSWER_KINDS)[number];

/** What started a sync (kb_sync_runs.trigger). */
export const KB_SYNC_TRIGGERS = ["manual", "scheduled"] as const;
export type KbSyncTrigger = (typeof KB_SYNC_TRIGGERS)[number];

/** Why an employee reported an answer (kb_answer_reports.reason). */
export const KB_REPORT_REASONS = [
  /** A statement is not what the project did. */
  "wrong_fact",
  /** A citation does not support the statement it is attached to. */
  "wrong_source",
  /** The answer missed a document the reporter knows about. */
  "missing_source",
  /** A newer version of the document says something else. */
  "outdated",
  "other",
] as const;
export type KbReportReason = (typeof KB_REPORT_REASONS)[number];

/** Where a report is in the admin's queue (kb_answer_reports.status). */
export const KB_REPORT_STATUSES = ["open", "resolved", "dismissed"] as const;
export type KbReportStatus = (typeof KB_REPORT_STATUSES)[number];
