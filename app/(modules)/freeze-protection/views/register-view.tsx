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
 * One project's register: the selected unit's steps and history in the wide
 * container, the project's equipment in the narrow column beside it. The
 * first unit is selected when the URL names none. What is showing is in the URL
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

      {/* The selected unit is the work, so it gets the room; the list is the narrow column beside it. */}
      <div className="grid grid-cols-1 gap-5 lg:min-h-[22rem] lg:flex-[1_1_0px] lg:grid-cols-[minmax(0,1fr)_24rem] lg:grid-rows-[minmax(0,1fr)]">
        <Card padding="p-0" className="flex min-h-[24rem] flex-col lg:min-h-0">
          {selected ? (
            <StepPane key={selected.id} line={selected} history={history} />
          ) : (
            <Empty>No equipment yet. Add each unit from the mechanical equipment schedule.</Empty>
          )}
        </Card>

        <Card padding="p-0" className="flex min-h-0 flex-col">
          <div className="flex shrink-0 items-center justify-between gap-3 border-b border-[var(--border)] px-4 py-3">
            <h3 className="eyebrow text-[var(--muted)]">Equipment · {lines.length}</h3>
            {panel !== "equipment" && (
              <Button variant="primary" href={`${base}&new=equipment`} className="h-8! px-3!">
                <Plus size={14} aria-hidden="true" />
                Add equipment
              </Button>
            )}
          </div>

          {lines.length === 0 ? (
            <p className="px-4 py-6 text-[0.8125rem] text-[var(--muted)]">
              List every unit on the mechanical equipment schedule, including units not yet installed and systems not yet filled.
            </p>
          ) : (
            <ul className="min-h-0 flex-1 overflow-y-auto p-2">
              {lines.map((e) => {
                const d = disposition(e);
                const isSelected = e.id === selected?.id;
                const detail = [e.equipmentType, e.areaServed, STATUS_LABEL[e.status]].filter(Boolean).join(" · ");
                return (
                  <li key={e.id}>
                    <Link
                      href={`${base}&equipment=${e.id}`}
                      scroll={false}
                      aria-current={isSelected ? "true" : undefined}
                      className={
                        "flex flex-col gap-0.5 rounded-[var(--radius-row)] px-3 py-2 text-[0.8125rem] hover:bg-[var(--neutral-50)] " +
                        (isSelected ? "bg-[var(--neutral-50)]" : "")
                      }
                    >
                      <span className="flex items-center justify-between gap-2">
                        <span className={"truncate font-mono " + (isSelected ? "font-medium" : "")}>{e.name}</span>
                        <Pill tone={d.tone}>{d.label}</Pill>
                      </span>
                      <span className="truncate text-[0.75rem] text-[var(--muted)]">{detail}</span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>
      </div>
    </div>
  );
}
