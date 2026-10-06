"use client";

import { useState } from "react";
import { Plus } from "lucide-react";
import { PLACEHOLDER_SETTINGS_WORKFLOWS } from "@/lib/modules/cost-intelligence/placeholder-settings";
import type { Workflow, WorkflowStatus, WorkflowStep } from "@/lib/modules/cost-intelligence/types";
import { Button } from "../ui/Button";
import { Card } from "../ui/Card";
import { Pill, type PillTone } from "../ui/Pill";
import { Segmented } from "../ui/Segmented";

const STATUS_TONE: Record<WorkflowStatus, PillTone> = { Active: "ok", Paused: "muted", Draft: "draft" };

const TOGGLE: Record<WorkflowStatus, { label: string; to: WorkflowStatus }> = {
  Active: { label: "Pause workflow", to: "Paused" },
  Paused: { label: "Resume workflow", to: "Active" },
  Draft: { label: "Activate workflow", to: "Active" },
};

/** Workflows on the left; the selected one's steps on the right. */
export function WorkflowsView() {
  const [workflows, setWorkflows] = useState(PLACEHOLDER_SETTINGS_WORKFLOWS);
  const [selectedId, setSelectedId] = useState(workflows[0]?.id);
  const wf = workflows.find((w) => w.id === selectedId) ?? workflows[0];

  function update(patch: (w: Workflow) => Partial<Workflow>) {
    setWorkflows((all) => all.map((w) => (w.id === wf?.id ? { ...w, ...patch(w) } : w)));
  }

  return (
    <div className="grid grid-cols-1 gap-5 lg:grid-cols-[21rem_minmax(0,1fr)] lg:min-h-[22rem] lg:flex-[1_1_0px] lg:grid-rows-[minmax(0,1fr)]">
      <Card padding="p-0" className="flex min-h-0 flex-col">
        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-[var(--divider-soft)] px-4 py-3">
          <span className="eyebrow whitespace-nowrap text-[var(--muted)]">Workflows · {workflows.length}</span>
          <Button>
            <Plus size={14} aria-hidden="true" />
            New workflow
          </Button>
        </div>
        <ul className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto p-2">
          {workflows.map((w) => {
            const selected = w.id === wf?.id;
            return (
              <li key={w.id}>
                <button
                  type="button"
                  aria-current={selected ? "true" : undefined}
                  onClick={() => setSelectedId(w.id)}
                  className={
                    "flex w-full items-center justify-between gap-3 rounded-[var(--radius-control)] px-3 py-1.5 text-left text-[0.8125rem] transition-colors " +
                    (selected
                      ? "bg-[color-mix(in_srgb,var(--module-accent)_16%,transparent)] font-semibold text-[var(--module-accent-ink)]"
                      : "text-[var(--foreground)] hover:bg-[var(--neutral-100)]")
                  }
                >
                  <span className="truncate">{w.name}</span>
                  <Pill tone={STATUS_TONE[w.status]}>{w.status}</Pill>
                </button>
              </li>
            );
          })}
        </ul>
      </Card>

      {wf && (
        <Card padding="p-6" className="min-h-0 overflow-y-auto">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="min-w-0">
              <div className="flex items-center gap-2.5">
                <h2 className="text-xl font-semibold">{wf.name}</h2>
                <Pill tone={STATUS_TONE[wf.status]}>{wf.status}</Pill>
              </div>
              <p className="mt-1 text-[0.8125rem] text-[var(--muted)]">{wf.description}</p>
              <p className="mt-1 text-[0.75rem] text-[var(--muted)]">{wf.runs30d} runs in 30 days</p>
            </div>
            <Button onClick={() => update((w) => ({ status: TOGGLE[w.status].to }))}>{TOGGLE[wf.status].label}</Button>
          </div>

          <p className="eyebrow mb-3 mt-7 text-[var(--muted)]">Steps · run in order</p>
          <ol className="flex flex-col gap-2.5">
            {wf.steps.map((s, i) => (
              <li
                key={s.skillId}
                className="flex flex-wrap items-center gap-4 rounded-[var(--radius-row)] border border-[var(--border)] bg-white px-4 py-3"
              >
                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[var(--neutral-100)] text-[0.75rem] font-semibold">
                  {i + 1}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-[0.875rem] font-medium">{s.name}</p>
                  <p className="font-mono text-[0.75rem] text-[var(--muted)]">{s.skillId}</p>
                </div>
                <Segmented<WorkflowStep["mode"]>
                  tone="light"
                  label={`Version for ${s.name}`}
                  value={s.mode}
                  onChange={(mode) =>
                    update((w) => ({ steps: w.steps.map((x) => (x.skillId === s.skillId ? { ...x, mode } : x)) }))
                  }
                  options={[
                    { value: "live", label: `Follow live · ${s.version}` },
                    { value: "pinned", label: `Pin ${s.version}` },
                  ]}
                />
              </li>
            ))}
          </ol>
        </Card>
      )}
    </div>
  );
}
