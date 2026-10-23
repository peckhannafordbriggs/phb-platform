"use client";

import Link from "next/link";
import { Plus } from "lucide-react";
import { disposition } from "@/lib/modules/freeze-protection/disposition";
import type { FpHistoryEntry, FpLine, FpProject } from "@/lib/modules/freeze-protection/types";
import { STATUS_LABEL } from "@/lib/modules/freeze-protection/vocab";
import { Button, Card, Empty, Pill } from "../ui/kit";
import { EquipmentForm } from "./equipment-form";
import { ProjectBar } from "./project-bar";
import { ProjectForm } from "./project-form";
import { StepPane } from "./step-pane";

const COIL_SHORT = { none: "None", water: "Water", glycol: "Glycol", steam: "Steam" } as const;
const COLUMNS = ["Name", "Type", "Area served", "Status", "Coil", "Disposition"];
const GRID = {
  gridTemplateColumns: "minmax(0,0.9fr) minmax(0,0.7fr) minmax(0,1.2fr) minmax(0,0.9fr) minmax(0,0.6fr) minmax(0,1fr)",
};

export type RegisterPanel = "project" | "equipment" | null;

type Props = {
  project: FpProject | null;
  lines: FpLine[];
  selected: FpLine | null;
  /** The selected unit's history, from the audit log. */
  history: FpHistoryEntry[];
  panel: RegisterPanel;
  today: string;
};

/**
 * One project's register: its units on the left, the selected unit's steps and
 * history on the right. What is showing is in the URL
 * (`?project=&equipment=&new=`), so refresh and back work.
 */
export function RegisterView(props: Props) {
  const { project, panel, today } = props;
  if (panel === "project") {
    return <ProjectForm cancelHref={project ? `/freeze-protection?project=${project.id}` : "/freeze-protection"} today={today} />;
  }
  if (project === null) {
    return (
      <Card className="flex flex-1">
        <Empty>
          <p>No projects yet. A project is one job number and the equipment from its mechanical schedule.</p>
          <Button variant="primary" href="/freeze-protection?new=project">
            <Plus size={16} aria-hidden="true" />
            New project
          </Button>
        </Empty>
      </Card>
    );
  }
  return <Register {...props} project={project} />;
}

function Register({ project, lines, selected, history, panel }: Props & { project: FpProject }) {
  const base = `/freeze-protection?project=${encodeURIComponent(project.id)}`;

  return (
    <div className="flex flex-col gap-5 lg:min-h-0 lg:flex-1">
      <ProjectBar project={project} lines={lines} />
      {panel === "equipment" && <EquipmentForm projectId={project.id} doneHref={base} />}

      <div className="grid grid-cols-1 gap-5 lg:min-h-[22rem] lg:flex-[1_1_0px] lg:grid-cols-[minmax(0,1fr)_32rem] lg:grid-rows-[minmax(0,1fr)]">
        <Card padding="p-0" className="flex min-h-0 flex-col">
          <div className="flex shrink-0 items-center justify-between gap-3 px-5 pt-4">
            <h3 className="eyebrow text-[var(--muted)]">Equipment · {lines.length}</h3>
            {panel !== "equipment" && (
              <Button variant="primary" href={`${base}&new=equipment`}>
                <Plus size={16} aria-hidden="true" />
                Add equipment
              </Button>
            )}
          </div>

          <div className="grid shrink-0 gap-4 border-b border-[var(--border)] px-5 pb-3 pt-4" style={GRID}>
            {COLUMNS.map((h) => (
              <span key={h} className="eyebrow truncate text-[var(--muted)]">
                {h}
              </span>
            ))}
          </div>

          {lines.length === 0 ? (
            <p className="px-5 py-8 text-[0.8125rem] text-[var(--muted)]">
              List every unit on the mechanical equipment schedule, including units not yet installed and systems not yet filled.
            </p>
          ) : (
            <ul className="min-h-0 flex-1 overflow-y-auto px-2 py-1">
              {lines.map((e) => {
                const d = disposition(e);
                const isSelected = e.id === selected?.id;
                return (
                  <li key={e.id}>
                    <Link
                      href={`${base}&equipment=${e.id}`}
                      scroll={false}
                      aria-current={isSelected ? "true" : undefined}
                      className={
                        "grid items-center gap-4 rounded-[var(--radius-row)] px-3 py-2.5 text-[0.8125rem] hover:bg-[var(--neutral-50)] " +
                        (isSelected ? "bg-[var(--neutral-50)] font-medium" : "")
                      }
                      style={GRID}
                    >
                      <span className="truncate font-mono">{e.name}</span>
                      <span className="truncate text-[var(--muted)]">{e.equipmentType ?? "—"}</span>
                      <span className="truncate text-[var(--muted)]">{e.areaServed ?? "—"}</span>
                      <span className="truncate">{STATUS_LABEL[e.status]}</span>
                      <span className="truncate">{e.coil ? COIL_SHORT[e.coil] : "—"}</span>
                      <span className="min-w-0">
                        <Pill tone={d.tone}>{d.label}</Pill>
                      </span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>

        <Card padding="p-0" className="flex min-h-[24rem] flex-col lg:min-h-0">
          {selected ? (
            <StepPane key={selected.id} line={selected} history={history} />
          ) : (
            <Empty>Pick a unit to see where it stands and record its results.</Empty>
          )}
        </Card>
      </div>
    </div>
  );
}
