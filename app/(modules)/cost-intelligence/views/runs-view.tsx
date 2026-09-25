import { RunHistory, RunDetail } from "./parts";
import { useState } from "react";

/** 1a: the runs list beside the selected run. */
export function RunsView() {
  const [selectedRun, setSelectedRun] = useState(null);
  
  return (
    <div className="grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)]">
      <RunHistory selectedRun={selectedRun} setSelectedRun={setSelectedRun} />
      <RunDetail selectedRun={selectedRun} />
    </div>
  );
}

/** A single run, full width. */
export function RunView() {
  return (
    <div className="max-w-3xl">
      <RunDetail />
    </div>
  );
}

