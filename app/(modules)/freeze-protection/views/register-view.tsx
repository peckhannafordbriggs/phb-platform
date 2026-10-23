"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Plus } from "lucide-react";
import { disposition } from "@/lib/modules/freeze-protection/disposition";
import type { FpLine, FpProject, FpVerification } from "@/lib/modules/freeze-protection/types";
import { STATUS_LABEL } from "@/lib/modules/freeze-protection/vocab";
import { call } from "../client";
import { INPUT } from "../ui/Field";
import { Button, Card, Empty, Pill } from "../ui/kit";
import { EquipmentForm } from "./equipment-form";
import { ProjectBar } from "./project-bar";
import { ProjectForm } from "./project-form";
import { StepPane } from "./step-pane";

const COIL_SHORT = { none: "None", water: "Water", glycol: "Glycol", steam: "Steam" } as const;

export type RegisterPanel = "project" | "equipment" | null;

type Props = {
  project: FpProject | null;
  verifications: FpVerification[];
  verification: FpVerification | null;
  lines: FpLine[];
  selected: FpLine | null;
  /** The building the switcher shows, or null for all of them. */
  buildingId: string | null;
  panel: RegisterPanel;
  today: string;
};

/**
 * One project's register for one verification round: the units on the left,
 * the selected unit's steps on the right. Each building has its own equipment
 * schedule; the switcher shows one building's or all of them. Everything that
 * says what is showing is in the URL
 * (`?project=&round=&building=&equipment=&new=`), so refresh and back work.
 */
export function RegisterView(props: Props) {
  const { project, panel } = props;
  if (panel === "project") {
    return <ProjectForm cancelHref={project ? `/freeze-protection?project=${project.id}` : "/freeze-protection"} />;
  }
  if (project === null) {
    return (
      <Card className="flex flex-1">
        <Empty>
          <p>No projects yet. A project is one job number, with its buildings and each building&rsquo;s equipment schedule.</p>
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

function Register({ project, verifications, verification, lines, selected, buildingId, panel, today }: Props & { project: FpProject }) {
  const building = project.buildings.find((b) => b.id === buildingId) ?? null;
  const shown = building ? lines.filter((l) => l.buildingId === building.id) : lines;

  const round = verification ? `&round=${verification.id}` : "";
  const here = (b: string | null) =>
    `/freeze-protection?project=${encodeURIComponent(project.id)}${round}${b ? `&building=${encodeURIComponent(b)}` : ""}`;
  const current = here(building?.id ?? null);

  // One building showing: its name is already in the switcher, so the column goes.
  const columns = building
    ? ["Equipment", "Area served", "Status", "Coil", "Disposition"]
    : ["Equipment", "Building", "Area served", "Status", "Coil", "Disposition"];
  const grid = {
    gridTemplateColumns: building
      ? "minmax(0,0.8fr) minmax(0,1.4fr) minmax(0,0.9fr) minmax(0,0.6fr) minmax(0,1fr)"
      : "minmax(0,0.8fr) minmax(0,0.8fr) minmax(0,1.2fr) minmax(0,0.9fr) minmax(0,0.6fr) minmax(0,1fr)",
  };

  return (
    <div className="flex flex-col gap-5 lg:min-h-0 lg:flex-1">
      <ProjectBar project={project} verifications={verifications} verification={verification} lines={shown} today={today} />
      {panel === "equipment" && (
        <EquipmentForm buildings={project.buildings} defaultBuildingId={building?.id ?? null} doneHref={current} />
      )}

      <div className="grid grid-cols-1 gap-5 lg:min-h-[22rem] lg:flex-[1_1_0px] lg:grid-cols-[minmax(0,1fr)_32rem] lg:grid-rows-[minmax(0,1fr)]">
        <Card padding="p-0" className="flex min-h-0 flex-col">
          <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 px-5 pt-4">
            <BuildingSwitcher project={project} selectedId={building?.id ?? null} href={here} />
            {panel !== "equipment" && (
              <Button variant="primary" href={`${current}&new=equipment`}>
                <Plus size={16} aria-hidden="true" />
                Add equipment
              </Button>
            )}
          </div>

          <div className="grid shrink-0 gap-4 border-b border-[var(--border)] px-5 pb-3 pt-4" style={grid}>
            {columns.map((h) => (
              <span key={h} className="eyebrow truncate text-[var(--muted)]">
                {h}
              </span>
            ))}
          </div>

          {verification === null ? (
            <TableNote>
              {project.buildings.every((b) => b.equipmentCount === 0)
                ? "Add each building's units from its mechanical equipment schedule, including units not yet installed and systems not yet filled."
                : "Start a verification to see the register and record results."}
            </TableNote>
          ) : shown.length === 0 ? (
            <TableNote>
              {building ? `No equipment in ${building.name} in this verification.` : "No equipment in this verification."} List every piece of
              building equipment, including units not yet installed and systems not yet filled.
            </TableNote>
          ) : (
            <ul className="min-h-0 flex-1 overflow-y-auto px-2 py-1">
              {shown.map((e) => {
                const d = disposition(e);
                const isSelected = e.id === selected?.id;
                return (
                  <li key={e.id}>
                    <Link
                      href={`${current}&equipment=${e.id}`}
                      scroll={false}
                      aria-current={isSelected ? "true" : undefined}
                      className={
                        "grid items-center gap-4 rounded-[var(--radius-row)] px-3 py-2.5 text-[0.8125rem] hover:bg-[var(--neutral-50)] " +
                        (isSelected ? "bg-[var(--neutral-50)] font-medium" : "")
                      }
                      style={grid}
                    >
                      <span className="truncate font-mono">{e.tag}</span>
                      {!building && <span className="truncate text-[var(--muted)]">{e.buildingName}</span>}
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

          {verification !== null && (
            <p className="shrink-0 border-t border-[var(--divider-soft)] px-5 py-2.5 text-[0.75rem] text-[var(--muted)]">
              {shown.length} unit{shown.length === 1 ? "" : "s"}
              {building ? ` in ${building.name}` : ""} · {verification.verificationDate} verification
            </p>
          )}
        </Card>

        <Card padding="p-0" className="flex min-h-[24rem] flex-col lg:min-h-0">
          {selected ? (
            <StepPane line={selected} buildings={project.buildings} />
          ) : (
            <Empty>Pick a unit to see where it stands and record its results.</Empty>
          )}
        </Card>
      </div>
    </div>
  );
}

/**
 * All / one building per chip, and adding a building. Adding is one name and
 * Enter; the new building opens straight away, ready for its schedule.
 * Renaming and removing live in Edit project, away from a chip a stray click
 * would hit.
 */
function BuildingSwitcher({
  project,
  selectedId,
  href,
}: {
  project: FpProject;
  selectedId: string | null;
  href: (buildingId: string | null) => string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const total = project.buildings.reduce((n, b) => n + b.equipmentCount, 0);

  const add = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    startTransition(async () => {
      const r = await call<FpProject>("POST", `/projects/${project.id}/buildings`, { name });
      if (!r.ok) return setError(r.message);
      const created = r.data.buildings.find((b) => b.name.toLowerCase() === name.trim().toLowerCase());
      setName("");
      setAdding(false);
      router.push(href(created?.id ?? null), { scroll: false });
      router.refresh();
    });
  };

  const chip = (id: string | null, label: string, count: number) => {
    const on = id === selectedId;
    return (
      <li key={id ?? "all"}>
        <Link
          href={href(id)}
          scroll={false}
          aria-current={on ? "true" : undefined}
          className={
            "inline-flex h-8 items-center gap-1.5 rounded-full px-3 text-[0.8125rem] transition-colors " +
            (on ? "bg-[var(--neutral-900)] font-medium text-white" : "bg-[var(--neutral-100)] text-[var(--muted)] hover:text-[var(--foreground)]")
          }
        >
          {label}
          <span className={"font-mono text-[0.6875rem] " + (on ? "text-white/70" : "")}>{count}</span>
        </Link>
      </li>
    );
  };

  return (
    <div className="flex min-w-0 flex-col gap-1">
      <ul className="flex flex-wrap items-center gap-1.5" aria-label="Buildings">
        {project.buildings.length > 1 && chip(null, "All buildings", total)}
        {project.buildings.map((b) => chip(b.id, b.name, b.equipmentCount))}
        <li>
          {adding ? (
            <form onSubmit={add} className="flex items-center gap-1.5">
              <input
                autoFocus
                required
                value={name}
                placeholder="Building name"
                aria-label="New building name"
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") {
                    setAdding(false);
                    setError(null);
                  }
                }}
                className={INPUT + " h-8 w-44"}
              />
              <Button type="submit" disabled={pending} className="h-8! px-3!">
                Add
              </Button>
            </form>
          ) : (
            <button
              type="button"
              onClick={() => setAdding(true)}
              className="inline-flex h-8 items-center gap-1 rounded-full border border-dashed border-[var(--neutral-300)] px-3 text-[0.8125rem] text-[var(--muted)] hover:text-[var(--foreground)]"
            >
              <Plus size={13} aria-hidden="true" /> Building
            </button>
          )}
        </li>
      </ul>
      {error && <p className="text-[0.75rem] text-[var(--phb-maroon)]">{error}</p>}
    </div>
  );
}

function TableNote({ children }: { children: React.ReactNode }) {
  return <p className="px-5 py-8 text-[0.8125rem] text-[var(--muted)]">{children}</p>;
}
