"use client";

import { useState } from "react";
import { RunDetail, RunHistory, type Run } from "./parts";

// TODO(backend): replace with runs loaded from the Cost Intelligence API.
const PLACEHOLDER_RUNS: Run[] = [
  { id: "run-001", job: "Sample job A", workflow: "Estimate review", status: "Running", started: "09:12" },
  { id: "run-002", job: "Sample job B", workflow: "Cost rollup", status: "Waiting on you", started: "08:47" },
  { id: "run-003", job: "Sample job C", workflow: "Estimate review", status: "Completed", started: "Yesterday" },
];

/** 1a: the runs list beside the selected run. */
export function RunsView() {
  const [selectedRun, setSelectedRun] = useState<Run | null>(null);

  return (
    <div className="grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)]">
      <RunHistory runs={PLACEHOLDER_RUNS} selectedRun={selectedRun} setSelectedRun={setSelectedRun} />
      <RunDetail selectedRun={selectedRun} />
    </div>
  );
}

/** A single run, full width. */
export function RunView() {
  // TODO(backend): load the run for this page's runId.
  return (
    <div className="max-w-3xl">
      <RunDetail selectedRun={null} />
    </div>
  );
}
