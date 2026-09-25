/**
 * Placeholder data for the Cost Intelligence screens until the backend exists.
 * Every export here is replaced by a real source; delete this file when the last
 * one goes. TODO(backend).
 */
import type { Option, Run, RunActivity, RunStep } from "./types";

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

const STEP_NAMES = [
  "Queued",
  "Preparing files",
  "Running",
  "Awaiting decision",
  "Awaiting Excel save",
  "Writing outputs",
  "Completed",
];

/** The seven steps: those before `current` done (with `times`), `current` in progress, the rest pending. */
function steps(current: number, times: string[]): RunStep[] {
  return STEP_NAMES.map((name, i) => ({
    name,
    state: i < current ? "done" : i === current ? "current" : "pending",
    time: times[i],
  }));
}

const PLACEHOLDER_ACTIVITY: Record<string, RunActivity> = {
  // Sample project A, Estimate review, running.
  "run-001": {
    ledger: [
      { time: "09:12", title: "Run queued", detail: "Started from the platform" },
      { time: "09:13", title: "Read project folder", detail: "14 files from Bid Documents" },
      { time: "09:15", title: "Bid kickoff complete", detail: "Kickoff summary drafted" },
      { time: "09:21", title: "Estimate population started", detail: "Division 23 of 6 divisions" },
    ],
    steps: steps(2, ["09:12", "09:13", "09:15"]),
    pinned: [
      { name: "phb-bid-kickoff", version: "v1.4.0" },
      { name: "phb-estimate-population", version: "v2.3.1" },
    ],
    tokens: 184_320,
    cost: 2.76,
  },
  // Sample project B, Cost rollup, paused on a question.
  "run-002": {
    ledger: [
      { time: "08:47", title: "Run queued", detail: "Started from the platform" },
      { time: "08:48", title: "Read project folder", detail: "9 files from Bid Documents" },
      { time: "08:52", title: "Cost rollup started", detail: "Rolling up 212 line items" },
      { time: "08:58", title: "Waiting on you", detail: "Two spec sections conflict on duct material" },
    ],
    steps: steps(3, ["08:47", "08:48", "08:52", "08:58"]),
    pinned: [{ name: "phb-cost-rollup", version: "v1.1.2" }],
    tokens: 96_870,
    cost: 1.45,
  },
  // Sample project A, Cost rollup, finished.
  "run-003": {
    ledger: [
      { time: "14:02", title: "Run queued", detail: "Started from the platform" },
      { time: "14:03", title: "Read project folder", detail: "14 files from Bid Documents" },
      { time: "14:10", title: "Cost rollup complete", detail: "212 line items rolled up" },
      { time: "14:31", title: "Excel saved and checked", detail: "CE Import!M2705 matched" },
      { time: "14:33", title: "Outputs written", detail: "R01 Cost Rollup.xlsx to AI FILES" },
    ],
    steps: steps(7, ["14:02", "14:03", "14:04", "", "14:31", "14:33", "14:33"]),
    pinned: [{ name: "phb-cost-rollup", version: "v1.1.2" }],
    tokens: 131_540,
    cost: 1.97,
  },
};

/** The ledger, steps, pins and cost for this run, or undefined. Stands in for the backend lookup. */
export function getPlaceholderActivity(id: string): RunActivity | undefined {
  return PLACEHOLDER_ACTIVITY[id];
}
