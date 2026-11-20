import type { TrendStats } from "./stats";

/**
 * What "Explain this trend" answers (2026-11-20). Pure types, so the page's
 * client code can name them without importing the service.
 */

export type TrendSummaryState =
  | "written"
  | "withheld"
  | "no_data"
  | "not_summarisable"
  | "not_configured"
  | "over_ceiling"
  | "rate_limited";

export interface TrendSummaryResult {
  state: TrendSummaryState;
  summary: string | null;
  /** Why there is no summary, in words; null when there is one. */
  message: string | null;
  /** The range the summary covers - the cached row's, on a cache hit. */
  rangeFrom: string;
  rangeTo: string;
  timezone: string | null;
  newestReadingAt: string | null;
  generatedAt: string | null;
  /** True when this came from an earlier call and cost nothing now. */
  cached: boolean;
  costUsd: number;
  model: string | null;
  stats: TrendStats | null;
}
