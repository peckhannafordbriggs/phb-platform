import Link from "next/link";
import { disposition, visibleSteps } from "@/lib/modules/freeze-protection/disposition";
import type { FpLine, FpProject, FpVerification } from "@/lib/modules/freeze-protection/types";
import { COIL_LABEL, STATUS_LABEL, STEP_OWNER } from "@/lib/modules/freeze-protection/vocab";
import { Card } from "../ui/Card";
import { Pill } from "../ui/Pill";
import { Slot } from "../ui/Slot";

const COLUMNS = { gridTemplateColumns: "minmax(0,0.8fr) minmax(0,0.8fr) minmax(0,1.2fr) minmax(0,1fr) minmax(0,0.7fr) minmax(0,1fr)" };

/**
 * One round's register on the left; the selected line's steps on the right.
 * Selection is `?equipment=` (the unit id, stable across rounds).
 */
export function RegisterView({
  project,
  verification,
  equipment,
  selected,
}: {
  project: FpProject | null;
  verification: FpVerification | null;
  equipment: FpLine[];
  selected: FpLine | null;
}) {
  if (!project) return <NoProjects />;
  const href = (id: string) => `/freeze-protection?project=${encodeURIComponent(project.id)}&equipment=${id}`;

  return (
    <div className="flex flex-col gap-5 lg:min-h-0 lg:flex-1">
      <Card className="shrink-0">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <h2 className="text-base font-semibold">
            <span className="font-mono">{project.jobNumber}</span> {project.name}
          </h2>
          <p className="text-[0.8125rem] text-[var(--muted)]">
            Verification date{" "}
            <span className="font-mono text-[var(--foreground)]">{verification?.verificationDate ?? "no verification yet"}</span>
          </p>
        </div>
        <Slot label="Funnel" note="This project's register narrowing to verified." className="mt-4 min-h-14" />
      </Card>

      <div className="grid grid-cols-1 gap-5 lg:min-h-[22rem] lg:flex-[1_1_0px] lg:grid-cols-[minmax(0,1fr)_30rem] lg:grid-rows-[minmax(0,1fr)]">
        <Card padding="p-0" className="flex min-h-0 flex-col">
          <div className="grid shrink-0 gap-4 border-b border-[var(--border)] px-5 pb-3 pt-5" style={COLUMNS}>
            {["Equipment", "Building", "Area served", "Status", "Coil", "Disposition"].map((h) => (
              <span key={h} className="eyebrow text-[var(--muted)]">
                {h}
              </span>
            ))}
          </div>
          {equipment.length === 0 ? (
            <p className="px-5 py-8 text-[0.8125rem] text-[var(--muted)]">
              No equipment listed yet. List every piece of building equipment, including units not yet installed and
              systems not yet filled.
            </p>
          ) : (
            <ul className="min-h-0 flex-1 overflow-y-auto px-2 py-1">
              {equipment.map((e) => {
                const d = disposition(e);
                const isSelected = e.id === selected?.id;
                return (
                  <li key={e.id}>
                    <Link
                      href={href(e.id)}
                      scroll={false}
                      aria-current={isSelected ? "true" : undefined}
                      className={
                        "grid items-center gap-4 rounded-[var(--radius-row)] px-3 py-3 text-[0.8125rem] hover:bg-[var(--neutral-50)] " +
                        (isSelected ? "bg-[var(--neutral-50)] font-medium" : "")
                      }
                      style={COLUMNS}
                    >
                      <span className="truncate font-mono">{e.tag}</span>
                      <span className="truncate text-[var(--muted)]">{e.buildingName}</span>
                      <span className="truncate text-[var(--muted)]">{e.areaServed ?? "—"}</span>
                      <span className="truncate">{STATUS_LABEL[e.status]}</span>
                      <span className="truncate">{e.coil && e.coil !== "none" ? COIL_LABEL[e.coil] : "—"}</span>
                      <span>
                        <Pill tone={d.tone}>{d.label}</Pill>
                      </span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>

        <Card padding="p-0" className="flex min-h-0 flex-col">
          {selected ? <StepPane equipment={selected} /> : <NoSelection />}
        </Card>
      </div>
    </div>
  );
}

/** Phase 1: the pane's sections in order, each a slot. Phase 2 builds the fields and the yes/no tests. */
function StepPane({ equipment: e }: { equipment: FpLine }) {
  const d = disposition(e);
  const show = visibleSteps(e);
  const step = (n: number, title: string) => `${n} · ${title}${STEP_OWNER[n] ? ` · ${STEP_OWNER[n]}` : ""}`;

  return (
    <>
      <div className="shrink-0 border-b border-[var(--divider-soft)] p-5">
        <div className="flex items-center justify-between gap-3">
          <h3 className="font-mono text-[0.9375rem] font-medium">{e.tag}</h3>
          <Pill tone={d.tone}>{d.label}</Pill>
        </div>
        <p className="mt-1 text-[0.8125rem] text-[var(--muted)]">{d.sentence}</p>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-5">
        <Slot label={step(1, "Equipment and status")} note="Tag, type, building, area served, status." />
        <Slot label={step(2, "Coil type")} />
        {show.exposure && <Slot label={step(3, "Outside air exposure")} />}
        {show.protection && <Slot label={step(4, "Protection in place")} />}
        {show.notify && <Slot label="Stop · Notify in writing" note="Who, date, method, response." />}
        {show.test && <Slot label={step(5, "Test the safety")} note="Four yes/no checks, trip °F, tested by, date, elements." />}
        {show.deficiency && <Slot label="Deficiency" note="Description, owner, due." />}
        {show.documentation && <Slot label={step(6, "Documented with the owner or controls vendor")} />}
        <Slot label="Notes" />
        <Slot label="Footer" note="Last change, by whom. Remove from register." className="min-h-14" />
      </div>
    </>
  );
}

function NoSelection() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
      <span className="diamond opacity-30" aria-hidden="true" />
      <p className="text-[0.8125rem] text-[var(--muted)]">Pick a line to see where it stands.</p>
    </div>
  );
}

function NoProjects() {
  return (
    <Card className="flex flex-1 flex-col items-center justify-center gap-3 text-center">
      <span className="diamond opacity-30" aria-hidden="true" />
      <p className="text-[0.8125rem] text-[var(--muted)]">No projects yet.</p>
    </Card>
  );
}
