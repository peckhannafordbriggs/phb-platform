import { writeAuditEvent } from "@/lib/audit";
import { prisma } from "@/lib/db";
import type { Prisma } from "@/lib/generated/prisma/client";
import { FREEZE_PROTECTION_MODULE_KEY as moduleKey } from "../constants";
import { type FpResult, cleanText, fail, isUniqueViolation, ok, parseId } from "../result";
import type { ImportEquipmentInput } from "../schemas";

/**
 * Saves the units the reviewer kept from an import, all or nothing.
 *
 * A name already in the register (or twice in the request) is skipped, never
 * overwritten: the import adds units, and editing one stays a deliberate act
 * in the step pane. Each new unit gets its own `fp.equipment_created` row
 * (source "import", file name), so its history starts at the import, plus one
 * `fp.schedule_imported` summary row for the project.
 */

export interface ImportOutcome {
  created: number;
  skipped: string[];
}

export async function importEquipment(actorId: string, input: ImportEquipmentInput): Promise<FpResult<ImportOutcome>> {
  const projectId = parseId(input.projectId);
  if (projectId === null) return fail("not_found", "Project not found.");
  const fileName = cleanText(input.fileName) ?? "equipment schedule";
  const project = await prisma.fpProject.findUnique({
    where: { id: projectId },
    select: { jobNumber: true, equipment: { select: { name: true, sortOrder: true } } },
  });
  if (project === null) return fail("not_found", "Project not found.");

  const taken = new Set(project.equipment.map((e) => e.name.toLowerCase()));
  let order = project.equipment.reduce((max, e) => Math.max(max, e.sortOrder + 1), project.equipment.length);
  const skipped: string[] = [];
  const rows: Prisma.FpEquipmentCreateManyInput[] = [];
  for (const r of input.rows) {
    const name = cleanText(r.name);
    if (name === null) continue;
    if (taken.has(name.toLowerCase())) {
      skipped.push(name);
      continue;
    }
    taken.add(name.toLowerCase());
    const suggestion = r.exposureSuggestion;
    rows.push({
      projectId,
      name,
      equipmentType: cleanText(r.equipmentType),
      areaServed: cleanText(r.areaServed),
      coil: r.coil,
      exposureSuggestion: suggestion,
      exposureEvidence: suggestion === null ? null : cleanText(r.exposureEvidence),
      source: cleanText(r.source),
      sortOrder: order++,
      updatedById: actorId,
    });
  }

  try {
    await prisma.$transaction(
      async (tx) => {
        const created = rows.length === 0 ? [] : await tx.fpEquipment.createManyAndReturn({ data: rows, select: { id: true, name: true } });
        for (const e of created) {
          await writeAuditEvent(tx, {
            action: "fp.equipment_created",
            actorEmployeeId: actorId,
            moduleKey,
            metadata: { projectId: input.projectId, jobNumber: project.jobNumber, equipmentId: e.id.toString(), name: e.name, source: "import", fileName },
          });
        }
        await writeAuditEvent(tx, {
          action: "fp.schedule_imported",
          actorEmployeeId: actorId,
          moduleKey,
          metadata: { projectId: input.projectId, jobNumber: project.jobNumber, fileName, created: created.length, skipped },
        });
      },
      { timeout: 60_000 },
    );
  } catch (error) {
    // Someone added a unit with one of these names while the import was being reviewed.
    if (isUniqueViolation(error)) return fail("name_taken", "A unit with one of these names was added while you were reviewing. Import again to skip it.");
    throw error;
  }
  return ok({ created: rows.length, skipped });
}
