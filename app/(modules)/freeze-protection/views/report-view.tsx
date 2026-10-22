import type { FpEquipment, FpProject } from "@/lib/modules/freeze-protection/types";
import { Card } from "../ui/Card";
import { Slot } from "../ui/Slot";

/**
 * The document handed to the CM or owner. Read-only except signoff and transmittal.
 * Phase 1: the sections in order. Phase 2: tables, print styles, the standalone download.
 */
export function ReportView({ project, equipment }: { project: FpProject | null; equipment: FpEquipment[] }) {
  if (!project) {
    return (
      <Card className="mx-auto flex w-full max-w-[56rem] flex-1 flex-col items-center justify-center gap-3 text-center">
        <span className="diamond opacity-30" aria-hidden="true" />
        <p className="text-[0.8125rem] text-[var(--muted)]">No projects yet, so there is no report.</p>
      </Card>
    );
  }
  return (
    <Card padding="p-8" className="mx-auto w-full max-w-[56rem]">
      <p className="eyebrow text-[var(--muted)]">Freeze protection verification</p>
      <h2 className="mt-1 text-lg font-semibold">{project.name}</h2>
      <p className="text-[0.8125rem] text-[var(--muted)]">Peck Hannaford + Briggs Controls Division</p>

      <div className="mt-6 flex flex-col gap-3">
        <Slot
          label="Notices"
          note="Verification date and what it covers. Equipment brought online Nov 1 to Mar 1 needs this before startup."
        />
        <Slot label="Summary" note={`Listed (${equipment.length}), with a coil, exposed, verified, stop, deficiencies, open.`} />
        <Slot label="Equipment register" note="Equipment, location, status, coil, outside air, protection, trip °F, tested, disposition." />
        <Slot label="Items requiring action" note="Stop and deficiency lines: finding, owner, due." />
        <Slot label="Open items" note="Lines waiting on a step, with the sentence that says which." />
        <Slot
          label="Step 7 · Signoff"
          note="Completed by, reviewed by. The reviewer must not be the person who did steps 3 to 6."
        />
        <Slot label="Transmittal" note="Transmitted to CM or owner, and the date." className="min-h-14" />
      </div>
    </Card>
  );
}
