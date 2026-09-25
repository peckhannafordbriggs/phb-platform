/**
 * Placeholder data for the Cost Intelligence screens until the backend exists.
 * Every export here is replaced by a real source; delete this file when the last
 * one goes. TODO(backend).
 */
import type { Option, Run } from "./types";

/** Newest first, the order the backend must return runs in. */
export const PLACEHOLDER_RUNS: Run[] = [
  { id: "run-001", project: "Sample project A", workflow: "Estimate review", status: "Running", started: "09:12" },
  { id: "run-002", project: "Sample project B", workflow: "Cost rollup", status: "Waiting on you", started: "08:47" },
  { id: "run-003", project: "Sample project A", workflow: "Cost rollup", status: "Completed", started: "Yesterday" },
];

export const PLACEHOLDER_WORKFLOWS: Option[] = [
  { value: "estimate-review", label: "Estimate review" },
  { value: "cost-rollup", label: "Cost rollup" },
  { value: "bid-comparison", label: "Bid comparison" },
];

export const PLACEHOLDER_PROJECTS: Option[] = [
  { value: "project-a", label: "Sample project A" },
  { value: "project-b", label: "Sample project B" },
  { value: "project-c", label: "Sample project C" },
];

/** The run with this id, or undefined. Stands in for the backend lookup. */
export function getPlaceholderRun(id: string): Run | undefined {
  return PLACEHOLDER_RUNS.find((r) => r.id === id);
}
