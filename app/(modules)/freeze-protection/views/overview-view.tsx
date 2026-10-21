import Link from "next/link";
import { disposition, toneCounts } from "@/lib/modules/freeze-protection/disposition";
import type { FpEquipment, FpProject, FpTone } from "@/lib/modules/freeze-protection/types";
import { withProject } from "../tabs";
import { Card } from "../ui/Card";
import { Label } from "../ui/Label";
import { Pill } from "../ui/Pill";
import { Slot } from "../ui/Slot";

/** Every project at once: what is verified, what stops work, what is waiting on someone. */
export function OverviewView({ projects, equipment }: { projects: FpProject[]; equipment: FpEquipment[] }) {
  const counts = toneCounts(equipment);
  const needsAction = equipment.filter((e) => {
    const t = disposition(e).tone;
    return t === "bad" || t === "warn";
  });
  const projectName = new Map(projects.map((p) => [p.id, p.name]));

  return (
    <div className="flex flex-col gap-5">
      <Slot
        label="Freeze season"
        note="Nov 1 to Mar 1. Days until the season starts, and that equipment brought online inside it needs this verification before startup."
        className="min-h-14"
      />

      {/* The four states a person acts on. Words carry the state; colour only repeats it. */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Tile label="Verified" count={counts.ok} tone="ok" />
        <Tile label="Stop work" count={counts.bad} tone="bad" />
        <Tile label="Deficiencies" count={counts.warn} tone="warn" />
        <Tile label="Open steps" count={counts.open} tone="open" />
      </div>

      <Card>
        <Label>All projects</Label>
        <Slot label="Funnel" note="Listed, has a coil, outside air exposure, protected, verified. Each stage a subset of the last." />
      </Card>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        <Card>
          <Label>Needs action · {needsAction.length}</Label>
          <ul className="flex flex-col">
            {needsAction.map((e) => {
              const d = disposition(e);
              return (
                <li key={e.id} className="border-b border-[var(--divider-soft)] last:border-b-0">
                  <Link
                    href={`${withProject("/freeze-protection/register", e.projectId)}&equipment=${e.id}`}
                    className="flex items-center gap-3 py-2.5 text-[0.8125rem] hover:bg-[var(--neutral-50)]"
                  >
                    <span className="font-mono font-medium">{e.name}</span>
                    <span className="min-w-0 flex-1 truncate text-[var(--muted)]">{projectName.get(e.projectId)}</span>
                    <Pill tone={d.tone}>{d.label}</Pill>
                  </Link>
                </li>
              );
            })}
          </ul>
        </Card>

        <Card>
          <Label>Projects · {projects.length}</Label>
          <Slot label="Project rows" note="Name, verification date, verified of exposed, signoff state. Opens the register." />
        </Card>
      </div>
    </div>
  );
}

const TONE_INK: Record<FpTone, string> = {
  ok: "var(--phb-teal-ink)",
  warn: "var(--phb-orange-ink)",
  bad: "var(--phb-maroon)",
  open: "var(--phb-purple)",
  closed: "var(--muted)",
};

/** Phase 1 tile: label and number. Phase 2 adds the tone wash and the sentence under the number. */
function Tile({ label, count, tone }: { label: string; count: number; tone: FpTone }) {
  return (
    <Card>
      <p className="eyebrow text-[var(--muted)]">{label}</p>
      <p className="mt-2 font-display text-3xl font-semibold" style={{ color: TONE_INK[tone] }}>
        {count}
      </p>
    </Card>
  );
}
