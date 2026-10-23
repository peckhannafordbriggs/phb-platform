"use client";

import Link from "next/link";
import { useState } from "react";
import { Plus, Search } from "lucide-react";
import { disposition } from "@/lib/modules/freeze-protection/disposition";
import type { FpLine, FpProject, FpTone, FpVerification } from "@/lib/modules/freeze-protection/types";
import { STATUS_LABEL } from "@/lib/modules/freeze-protection/vocab";
import { EquipmentForm } from "./equipment-form";
import { ProjectBar } from "./project-bar";
import { ProjectForm } from "./project-form";
import { StepPane } from "./step-pane";
import { INPUT } from "../ui/Field";
import { Button, Card, Empty, Pill } from "../ui/kit";

const COLUMNS = {
  gridTemplateColumns: "minmax(0,0.8fr) minmax(0,0.8fr) minmax(0,1.2fr) minmax(0,0.9fr) minmax(0,0.6fr) minmax(0,1fr)",
};
const COIL_SHORT = { none: "None", water: "Water", glycol: "Glycol", steam: "Steam" } as const;

export type RegisterPanel = "project" | "equipment" | null;

/** The table's state filter. Words, matching the pills. */
const SHOW: { value: string; label: string; tones: FpTone[] | null }[] = [
  { value: "all", label: "All units", tones: null },
  { value: "action", label: "Needs action", tones: ["bad", "warn"] },
  { value: "open", label: "Open steps", tones: ["open"] },
  { value: "verified", label: "Verified", tones: ["ok"] },
  { value: "closed", label: "Closed", tones: ["closed"] },
];

/**
 * One project's register for one verification round: the units on the left,
 * the selected unit's steps on the right. What is showing is in the URL
 * (`?project=&round=&equipment=&new=`), so refresh and back work; the table
 * filter is a per-visit convenience and is not.
 */
export function RegisterView({
  project,
  verifications,
  verification,
  lines,
  selected,
  panel,
  today,
}: {
  project: FpProject | null;
  verifications: FpVerification[];
  verification: FpVerification | null;
  lines: FpLine[];
  selected: FpLine | null;
  panel: RegisterPanel;
  today: string;
}) {
  if (panel === "project" || project === null) {
    return panel === "project" ? (
      <ProjectForm cancelHref={project ? `/freeze-protection?project=${project.id}` : "/freeze-protection"} />
    ) : (
      <Card className="flex flex-1">
        <Empty>
          <p>No projects yet. A project is one job number, with its buildings and the equipment from the mechanical schedule.</p>
          <Button variant="primary" href="/freeze-protection?new=project">
            <Plus size={16} aria-hidden="true" />
            New project
          </Button>
        </Empty>
      </Card>
    );
  }

  return (
    <Register
      project={project}
      verifications={verifications}
      verification={verification}
      lines={lines}
      selected={selected}
      panel={panel}
      today={today}
    />
  );
}

function Register({
  project,
  verifications,
  verification,
  lines,
  selected,
  panel,
  today,
}: {
  project: FpProject;
  verifications: FpVerification[];
  verification: FpVerification | null;
  lines: FpLine[];
  selected: FpLine | null;
  panel: RegisterPanel;
  today: string;
}) {
  const [query, setQuery] = useState("");
  const [show, setShow] = useState("all");
  const base = `/freeze-protection?project=${encodeURIComponent(project.id)}${verification ? `&round=${verification.id}` : ""}`;
  const unitCount = project.buildings.reduce((n, b) => n + b.equipmentCount, 0);

  const q = query.trim().toLowerCase();
  const tones = SHOW.find((s) => s.value === show)?.tones ?? null;
  const shown = lines.filter(
    (e) =>
      (tones === null || tones.includes(disposition(e).tone)) &&
      (q === "" || [e.tag, e.buildingName, e.equipmentType, e.areaServed].some((t) => t?.toLowerCase().includes(q))),
  );

  return (
    <div className="flex flex-col gap-5 lg:min-h-0 lg:flex-1">
      <ProjectBar project={project} verifications={verifications} verification={verification} lines={lines} today={today} />
      {panel === "equipment" && <EquipmentForm buildings={project.buildings} doneHref={base} />}

      <div className="grid grid-cols-1 gap-5 lg:min-h-[22rem] lg:flex-[1_1_0px] lg:grid-cols-[minmax(0,1fr)_32rem] lg:grid-rows-[minmax(0,1fr)]">
        <Card padding="p-0" className="flex min-h-0 flex-col">
          {lines.length > 0 && (
            <div className="flex shrink-0 flex-wrap items-center gap-2 px-5 pt-4">
              <div className="flex h-9 min-w-48 flex-1 items-center gap-2 rounded-[var(--radius-control)] border border-[var(--border)] bg-white px-3 focus-within:border-[var(--module-accent)]">
                <Search size={14} aria-hidden="true" className="shrink-0 text-[var(--muted)]" />
                <input
                  type="search"
                  aria-label="Filter by tag, building, type or area"
                  placeholder="Filter by tag, building, type or area"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  className="w-full bg-transparent text-[0.8125rem] outline-none"
                />
              </div>
              <select aria-label="Show" value={show} onChange={(e) => setShow(e.target.value)} className={INPUT + " w-auto"}>
                {SHOW.map((s) => (
                  <option key={s.value} value={s.value}>
                    {s.label}
                  </option>
                ))}
              </select>
            </div>
          )}
          <div className="grid shrink-0 gap-4 border-b border-[var(--border)] px-5 pb-3 pt-4" style={COLUMNS}>
            {["Equipment", "Building", "Area served", "Status", "Coil", "Disposition"].map((h) => (
              <span key={h} className="eyebrow truncate text-[var(--muted)]">
                {h}
              </span>
            ))}
          </div>
          {verification === null ? (
            <TableNote>
              {unitCount === 0
                ? "List every piece of building equipment from the schedule, including units not yet installed and systems not yet filled."
                : "Start a verification to see the register and record results."}
            </TableNote>
          ) : lines.length === 0 ? (
            <TableNote>
              No equipment in this verification. List every piece of building equipment, including units not yet installed and systems not yet
              filled.
            </TableNote>
          ) : shown.length === 0 ? (
            <TableNote>No units match the filter.</TableNote>
          ) : (
            <ul className="min-h-0 flex-1 overflow-y-auto px-2 py-1">
              {shown.map((e) => {
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
                      style={COLUMNS}
                    >
                      <span className="truncate font-mono">{e.tag}</span>
                      <span className="truncate text-[var(--muted)]">{e.buildingName}</span>
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
              {shown.length === lines.length ? "" : `${shown.length} of `}
              {lines.length} unit{lines.length === 1 ? "" : "s"} in the {verification.verificationDate} verification
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

function TableNote({ children }: { children: React.ReactNode }) {
  return <p className="px-5 py-8 text-[0.8125rem] text-[var(--muted)]">{children}</p>;
}
