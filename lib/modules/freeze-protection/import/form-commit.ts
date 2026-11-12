import { writeAuditEvent } from "@/lib/audit";
import { prisma } from "@/lib/db";
import type { Prisma } from "@/lib/generated/prisma/client";
import { FREEZE_PROTECTION_MODULE_KEY as moduleKey } from "../constants";
import { fromDateOnly, toDateOnly } from "../dates";
import { disposition } from "../disposition";
import { toLine } from "../equipment";
import { type FpResult, cleanText, fail, isUniqueViolation, ok, parseId } from "../result";
import type { FormImportRow, ImportFormInput } from "../schemas";
import { FORM_CHOICES, FORM_FIELD_LABEL } from "./form";

/**
 * Saves a filled verification form into a project, all or nothing.
 *
 * - A name not in the project is added with everything the form says.
 * - A name already there is matched (ignoring case) and only its BLANK fields
 *   are filled. An answer already on the platform is never overwritten, even
 *   when the form disagrees: the disagreement is returned as a difference for
 *   a person to settle in the step pane (Karthik, 2026-11-10).
 * - Status has no blank (it defaults to "In service"), so it counts as blank
 *   while nothing on the unit has been verified yet: no exposure, protection
 *   or test answer. After that a different status is a difference.
 *
 * Audited like a person's own saves, so history, "changed after review" and
 * the self-review check all see the import: `fp.equipment_created` (source
 * "form") per new unit, `fp.equipment_updated` for schedule fields and
 * `fp.result_updated` for answers, plus one `fp.form_imported` summary row.
 */

type Field = keyof Omit<FormImportRow, "name">;

const FIELDS = Object.keys(FORM_FIELD_LABEL) as Field[];
const SCHEDULE_FIELDS = new Set<Field>(["equipmentType", "areaServed", "coil", "notes"]);
const ANSWER_FIELDS: Field[] = ["exposure", "protection", "testFanStops", "testDamperCloses", "testValveFullFlow", "testManualReset"];
const DEFAULT_STATUS = "service";

export interface FormDifference {
  name: string;
  field: string;
  /** What the platform has, and keeps. */
  platform: string;
  form: string;
}

export interface FormImportOutcome {
  created: string[];
  filled: { name: string; fields: string[] }[];
  differences: FormDifference[];
  /** Matched units where the form added nothing new and disagreed with nothing. */
  unchanged: string[];
}

export async function importForm(actorId: string, input: ImportFormInput): Promise<FpResult<FormImportOutcome>> {
  const projectId = parseId(input.projectId);
  if (projectId === null) return fail("not_found", "Project not found.");
  const fileName = cleanText(input.fileName) ?? "verification form";
  const project = await prisma.fpProject.findUnique({
    where: { id: projectId },
    select: { jobNumber: true, equipment: { include: { updatedBy: { select: { firstName: true, lastName: true } } } } },
  });
  if (project === null) return fail("not_found", "Project not found.");

  // A form for another job would put its units in the wrong project. Blank is fine.
  const formJob = cleanText(input.jobNumber);
  if (formJob !== null && formJob.toLowerCase() !== project.jobNumber.trim().toLowerCase()) {
    return fail("wrong_project", `That form is for job ${formJob}, and this project is job ${project.jobNumber}. Upload it on job ${formJob}, or clear the job number on the form.`);
  }

  const byName = new Map(project.equipment.map((e) => [e.name.toLowerCase(), e]));
  let order = project.equipment.reduce((max, e) => Math.max(max, e.sortOrder + 1), project.equipment.length);
  const outcome: FormImportOutcome = { created: [], filled: [], differences: [], unchanged: [] };
  const creates: { data: Prisma.FpEquipmentUncheckedCreateInput; recorded: Changes }[] = [];
  const updates: { id: bigint; name: string; data: Record<string, unknown>; schedule: Changes; answers: Changes }[] = [];
  const seen = new Set<string>();

  for (const row of input.rows) {
    const name = cleanText(row.name);
    if (name === null || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    const existing = byName.get(name.toLowerCase());

    if (existing === undefined) {
      const data: Record<string, unknown> = {};
      const recorded: Changes = {};
      for (const f of FIELDS) {
        const v = normalise(f, row[f]);
        if (v === null) continue;
        data[f] = f === "testDate" ? fromDateOnly(v as string) : v;
        if (!SCHEDULE_FIELDS.has(f)) recorded[f] = { from: null, to: v };
      }
      creates.push({
        data: { ...(data as object), projectId, name, sortOrder: order++, source: `Form · ${fileName}`.slice(0, 200), updatedById: actorId },
        recorded,
      });
      outcome.created.push(name);
      continue;
    }

    const stored = existing as unknown as Record<string, unknown>;
    const untouched = ANSWER_FIELDS.every((f) => stored[f] === null);
    const data: Record<string, unknown> = {};
    const schedule: Changes = {};
    const answers: Changes = {};
    const filled: string[] = [];
    for (const f of FIELDS) {
      const v = normalise(f, row[f]);
      if (v === null) continue;
      const have = f === "testDate" ? toDateOnly(stored[f] as Date | null) : (stored[f] as string | number | null);
      const blankHere = have === null || (f === "status" && have === DEFAULT_STATUS && untouched);
      if (blankHere && have !== v) {
        data[f] = f === "testDate" ? fromDateOnly(v as string) : v;
        (SCHEDULE_FIELDS.has(f) ? schedule : answers)[f] = { from: have, to: v };
        filled.push(FORM_FIELD_LABEL[f]);
      } else if (!same(have, v)) {
        outcome.differences.push({ name: existing.name, field: FORM_FIELD_LABEL[f], platform: show(f, have), form: show(f, v) });
      }
    }
    if (filled.length > 0) {
      updates.push({ id: existing.id, name: existing.name, data, schedule, answers });
      outcome.filled.push({ name: existing.name, fields: filled });
    } else if (!outcome.differences.some((d) => d.name === existing.name)) {
      outcome.unchanged.push(existing.name);
    }
  }

  const base = { projectId: input.projectId, jobNumber: project.jobNumber };
  try {
    await prisma.$transaction(
      async (tx) => {
        for (const { data, recorded } of creates) {
          const e = await tx.fpEquipment.create({ data, include: { updatedBy: { select: { firstName: true, lastName: true } } } });
          const meta = { ...base, equipmentId: e.id.toString(), name: e.name };
          await writeAuditEvent(tx, { action: "fp.equipment_created", actorEmployeeId: actorId, moduleKey, metadata: { ...meta, source: "form", fileName } });
          // What the form recorded, so the unit's history says so and the
          // self-review check counts the importer as having recorded results.
          if (Object.keys(recorded).length > 0) {
            await writeAuditEvent(tx, {
              action: "fp.result_updated",
              actorEmployeeId: actorId,
              moduleKey,
              metadata: { ...meta, changes: recorded, disposition: disposition(toLine(e)).code, source: "form", fileName },
            });
          }
        }
        for (const u of updates) {
          const e = await tx.fpEquipment.update({
            where: { id: u.id },
            data: { ...(u.data as Prisma.FpEquipmentUncheckedUpdateInput), updatedById: actorId },
            include: { updatedBy: { select: { firstName: true, lastName: true } } },
          });
          const meta = { ...base, equipmentId: u.id.toString(), name: u.name, source: "form", fileName };
          if (Object.keys(u.schedule).length > 0) {
            await writeAuditEvent(tx, { action: "fp.equipment_updated", actorEmployeeId: actorId, moduleKey, metadata: { ...meta, changes: u.schedule } });
          }
          if (Object.keys(u.answers).length > 0) {
            await writeAuditEvent(tx, {
              action: "fp.result_updated",
              actorEmployeeId: actorId,
              moduleKey,
              metadata: { ...meta, changes: u.answers, disposition: disposition(toLine(e)).code },
            });
          }
        }
        await writeAuditEvent(tx, {
          action: "fp.form_imported",
          actorEmployeeId: actorId,
          moduleKey,
          metadata: {
            ...base,
            fileName,
            created: outcome.created.length,
            filled: outcome.filled.length,
            differences: outcome.differences.length,
          },
        });
      },
      { timeout: 60_000 },
    );
  } catch (error) {
    if (isUniqueViolation(error)) return fail("name_taken", "A unit with one of these names was added while the form was importing. Import it again.");
    throw error;
  }
  return ok(outcome);
}

type Changes = Record<string, { from: unknown; to: unknown }>;

/** Free text trimmed (empty is blank); everything else as the schema let it through. */
function normalise(f: Field, v: unknown): string | number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "string") return ["equipmentType", "areaServed", "notes", "testedBy"].includes(f) ? cleanText(v) : v;
  return v as number;
}

/** Text compares ignoring case and spacing, so "ahu  1 roof" on a form is not a difference from "AHU 1 Roof". */
function same(a: string | number | null, b: string | number | null): boolean {
  if (typeof a === "string" && typeof b === "string") return a.replace(/\s+/g, " ").trim().toLowerCase() === b.replace(/\s+/g, " ").trim().toLowerCase();
  return a === b;
}

const LABELS: Partial<Record<Field, Record<string, string>>> = {
  coil: invert(FORM_CHOICES.coil),
  status: invert(FORM_CHOICES.status),
  exposure: invert(FORM_CHOICES.exposure),
  protection: invert(FORM_CHOICES.protection),
  testFanStops: invert(FORM_CHOICES.yesNo),
  testDamperCloses: invert(FORM_CHOICES.yesNo),
  testValveFullFlow: invert(FORM_CHOICES.yesNo),
  testManualReset: invert(FORM_CHOICES.yesNo),
};

/** A stored value in the words the form uses, so the two columns of a difference read alike. */
function show(f: Field, v: string | number | null): string {
  if (v === null) return "Blank";
  if (typeof v === "number") return f === "tripTempF" ? `${v} °F` : String(v);
  return LABELS[f]?.[v] ?? v;
}

function invert(map: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(map).map(([label, value]) => [value, label]));
}
