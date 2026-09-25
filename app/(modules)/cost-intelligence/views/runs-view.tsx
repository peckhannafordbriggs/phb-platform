"use client";

import { useState } from "react";
import { useSearchParams } from "next/navigation";
import { PLACEHOLDER_RUNS } from "@/lib/modules/cost-intelligence/placeholder";
import type { Run } from "@/lib/modules/cost-intelligence/types";
import { RunDetail, RunHistory, RunLauncher } from "./parts";

const PROJECTS = [...new Set(PLACEHOLDER_RUNS.map((r) => r.project))].map((p) => ({ value: p, label: p }));

/** 1a: the runs list beside the selected run. */
export function RunsView() {
  const [selectedRun, setSelectedRun] = useState<Run | null>(null);
  const [project, setProject] = useState("");
  const searchParams = useSearchParams();

  const runs = project ? PLACEHOLDER_RUNS.filter((r) => r.project === project) : PLACEHOLDER_RUNS;
  // Runs are newest first, so with nothing picked (or the pick filtered out) show the latest.
  const shownRun = runs.find((r) => r.id === selectedRun?.id) ?? runs[0] ?? null;

  return (
    <div className="flex flex-col gap-5">
      {searchParams.get("new") && (
        <div className="mx-auto w-full max-w-3xl">
          <RunLauncher />
        </div>
      )}

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)]">
        <RunHistory
          runs={runs}
          projects={PROJECTS}
          project={project}
          setProject={setProject}
          selectedRun={shownRun}
          setSelectedRun={setSelectedRun}
        />
        <RunDetail selectedRun={shownRun} />
      </div>
    </div>
  );
}
