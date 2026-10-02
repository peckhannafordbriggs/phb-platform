"use client"

import { useState } from "react";
import { ArrowUpRight } from "lucide-react";
import { useRouter } from "next/navigation";
import { PLACEHOLDER_PROJECTS, PLACEHOLDER_RUNS, PLACEHOLDER_WORKFLOWS } from "@/lib/modules/cost-intelligence/placeholder";
import type { Run, RunActivity, RunStep } from "@/lib/modules/cost-intelligence/types";
import { Bar } from "../ui/Bar";
import { Button } from "../ui/Button";
import { Card } from "../ui/Card";
import { Dropdown, type DropdownOption } from "../ui/Dropdown";
import { FilterMenu } from "../ui/FilterMenu";
import { Label } from "../ui/Label";
import { Table } from "../ui/Table";

/** A diamond node, as on the skill pipeline and the step timeline. */
export function Node({
  size = 10,
  color = "var(--neutral-300)",
  filled = false,
}: {
  size?: number;
  color?: string;
  filled?: boolean;
}) {
  return (
    <span
      aria-hidden="true"
      className={"diamond" + (filled ? " diamond--filled" : "")}
      style={{ width: size, height: size, color }}
    />
  );
}

const STEP_COLOR: Record<RunStep["state"], string> = {
  done: "var(--neutral-600)",
  current: "var(--module-accent)",
  pending: "var(--neutral-300)",
};

/** The seven-step run timeline: node, step name, time. */
export function Timeline({ steps }: { steps: RunStep[] }) {
  return (
    <ol className="flex flex-col">
      {steps.map((s) => (
        <li
          key={s.name}
          aria-current={s.state === "current" ? "step" : undefined}
          className={
            "flex items-center gap-3 py-1.5 text-[0.8125rem] " +
            (s.state === "pending" ? "text-[var(--muted)]" : "text-[var(--foreground)]") +
            (s.state === "current" ? " font-medium" : "")
          }
        >
          <Node color={STEP_COLOR[s.state]} />
          <span className="flex-1">{s.name}</span>
          {s.time && <span className="text-[var(--muted)]">{s.time}</span>}
        </li>
      ))}
    </ol>
  );
}

/** A paused-run checkpoint: the question, its context, and the options to pick from. */
export function Checkpoint({ options = 3, columns = false }: { options?: number; columns?: boolean }) {
  return (
    <div className="rounded-[var(--radius-row)] border border-dashed border-[var(--neutral-300)] bg-[var(--neutral-50)] p-4">
      <Bar w={150} h={8} />
      <Bar w="85%" h={14} className="mt-3" />
      <Bar w="60%" h={14} className="mt-2" />
      <Bar w="95%" h={8} className="mt-3" />
      <Bar w="80%" h={8} className="mt-1.5" />
      <div className={"mt-4 gap-2 " + (columns ? "grid grid-cols-3" : "flex flex-col")}>
        {Array.from({ length: options }, (_, i) => (
          <div key={i} className="flex items-center gap-3 rounded-[var(--radius-control)] border border-[var(--border)] bg-white p-3">
            <span className="h-3.5 w-3.5 shrink-0 rounded-full border border-[var(--neutral-300)]" />
            <div className="flex-1">
              <Bar w="70%" h={9} />
              <Bar w="45%" h={7} className="mt-1.5" />
            </div>
          </div>
        ))}
      </div>
      <Button variant="primary" className="mt-4">
        Answer and resume
      </Button>
    </div>
  );
}

/** Run detail: the selected run's project, workflow, status and start time. */
export function RunDetail({ selectedRun }: { selectedRun: Run | null }) {
  if (!selectedRun) {
    return (
      <Card>
        <p className="text-[0.8125rem] text-[var(--muted)]">Select a run to see its details.</p>
      </Card>
    );
  }
  return (
    <Card className="flex flex-col gap-5">
      <div className="flex items-center justify-between">
        <span className="eyebrow text-[var(--muted)]">{selectedRun.id}</span>
        <span className="text-[0.8125rem]">{selectedRun.status}</span>
      </div>
      <div className="flex items-center justify-between gap-3">
        <h2 className="min-w-0 truncate text-lg font-medium text-[var(--foreground)]">{selectedRun.project}</h2>
        <Button href={`/cost-intelligence/runs/${selectedRun.id}`}>
          Open run
          <ArrowUpRight size={16} aria-hidden="true" />
        </Button>
      </div>
      <dl className="grid grid-cols-2 gap-4 border-t border-[var(--divider-soft)] pt-4 text-[0.8125rem]">
        <div>
          <dt className="text-[var(--muted)]">Workflow</dt>
          <dd>{selectedRun.workflow}</dd>
        </div>
        <div>
          <dt className="text-[var(--muted)]">Started</dt>
          <dd>{selectedRun.started}</dd>
        </div>
      </dl>
    </Card>
  );
}

/** The runs list, filterable by project. Clicking a row selects that run. */
export function RunHistory({
  runs,
  projects,
  project,
  setProject,
  selectedRun,
  setSelectedRun,
}: {
  runs: Run[];
  projects: DropdownOption[];
  project: string;
  setProject: (project: string) => void;
  selectedRun: Run | null;
  setSelectedRun: (run: Run) => void;
}) {
  return (
    <Card>
      {runs.length === 0 ? (
        <p className="text-[0.8125rem] text-[var(--muted)]">No runs yet.</p>
      ) : (
        <Table
          headers={[
            <span key="project" className="inline-flex items-center gap-1">
              Project
              <FilterMenu
                label="project"
                options={[{ value: "", label: "All projects" }, ...projects]}
                value={project}
                onChange={setProject}
              />
            </span>,
            "Workflow",
            "Status",
            "Started",
          ]}
          rows={runs.map((r) => [r.project, r.workflow, r.status, r.started])}
          pageSize={8}
          onRowClick={(i) => {
            const run = runs[i];
            if (run) setSelectedRun(run);
          }}
          selected={selectedRun ? runs.findIndex((r) => r.id === selectedRun.id) : undefined}
        />
      )}
    </Card>
  );
}

export function RunLauncher() {
  const router = useRouter();
  const [selectedWorkflow, setSelectedWorkflow] = useState("");
  const [selectedProject, setSelectedProject] = useState("");

  function startRun(workflow: string, project: string) {
    // TODO(backend): POST { workflow, project } and use the id it returns.
    void workflow;
    void project;
    const id = PLACEHOLDER_RUNS[0]?.id;

    router.push(`/cost-intelligence/runs/${id}`);
  }

  return (
    <Card>
      <div className="flex flex-wrap items-center gap-3">
        Run
        <Dropdown
          label="Workflow"
          placeholder="Choose a workflow"
          options={PLACEHOLDER_WORKFLOWS}
          value={selectedWorkflow}
          onChange={setSelectedWorkflow}
          className="min-w-40 flex-1"
        />
        on
        <Dropdown
          label="Project"
          placeholder="Choose a project"
          options={PLACEHOLDER_PROJECTS}
          value={selectedProject}
          onChange={setSelectedProject}
          className="min-w-40 flex-1"
        />
        <Button 
          variant="primary" 
          onClick={() => startRun(selectedWorkflow, selectedProject)}
          disabled={!selectedWorkflow || !selectedProject}
        >
          Start run
        </Button>
      </div>
    </Card>
  );
}

export function RunMonitor({ run, activity }: { run: Run; activity?: RunActivity }) {
  return (
    <div className="flex flex-col gap-5">
      <Card>
        <div className="flex items-center justify-between">
          <span className="eyebrow text-[var(--muted)]">{run.id}</span>
          <span className="text-[0.8125rem]">{run.status}</span>
        </div>
        <h2 className="mt-2 text-lg font-medium text-[var(--foreground)]">{run.project}</h2>
        <dl className="mt-4 grid grid-cols-2 gap-4 border-t border-[var(--divider-soft)] pt-4 text-[0.8125rem]">
          <div>
            <dt className="text-[var(--muted)]">Workflow</dt>
            <dd>{run.workflow}</dd>
          </div>
          <div>
            <dt className="text-[var(--muted)]">Started</dt>
            <dd>{run.started}</dd>
          </div>
        </dl>
      </Card>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <Card>
          <Label>Run ledger</Label>
          {activity?.ledger.length ? (
            <ol className="flex flex-col gap-4">
              {activity.ledger.map((e, i) => (
                <li key={i} className="flex items-start gap-3 text-[0.8125rem]">
                  <span className="w-12 shrink-0 text-[var(--muted)]">{e.time}</span>
                  <span className="mt-1">
                    <Node color="var(--neutral-600)" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="font-medium text-[var(--foreground)]">{e.title}</p>
                    {e.detail && <p className="mt-0.5 text-[var(--muted)]">{e.detail}</p>}
                  </div>
                </li>
              ))}
            </ol>
          ) : (
            <p className="text-[0.8125rem] text-[var(--muted)]">Nothing recorded yet.</p>
          )}
          {/* Only a run paused for a person has a question to show. */}
          {run.status === "Waiting on you" && (
            <div className="mt-5">
              <Checkpoint columns />
            </div>
          )}
        </Card>
        <div className="flex flex-col gap-5">
          <Card>
            <Label>Status</Label>
            {activity ? (
              <Timeline steps={activity.steps} />
            ) : (
              <p className="text-[0.8125rem] text-[var(--muted)]">No status yet.</p>
            )}
          </Card>
          <Card>
            <Label>Pinned for this run</Label>
            {activity?.pinned.length ? (
              <ul className="flex flex-col gap-3 text-[0.8125rem]">
                {activity.pinned.map((p) => (
                  <li key={p.name}>
                    <p className="font-medium text-[var(--foreground)]">{p.name}</p>
                    <p className="mt-0.5 text-[var(--muted)]">{p.version}</p>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-[0.8125rem] text-[var(--muted)]">No skills pinned.</p>
            )}
            <dl className="mt-5 grid grid-cols-2 gap-4 border-t border-[var(--divider-soft)] pt-4 text-[0.8125rem]">
              <div>
                <dt className="text-[var(--muted)]">Tokens</dt>
                <dd className="mt-1 text-lg font-medium text-[var(--foreground)]">
                  {activity ? activity.tokens.toLocaleString("en-US") : "—"}
                </dd>
              </div>
              <div>
                <dt className="text-[var(--muted)]">Estimated cost</dt>
                <dd className="mt-1 text-lg font-medium text-[var(--foreground)]">
                  {activity ? `$${activity.cost.toFixed(2)}` : "—"}
                </dd>
              </div>
            </dl>
          </Card>
        </div>
      </div>
    </div>
  );
}

export { Label };
