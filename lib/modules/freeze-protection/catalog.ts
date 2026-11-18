import { prisma } from "@/lib/db";
import { toneCounts } from "./disposition";
import { toLine } from "./equipment";
import { listProjectViews } from "./projects";
import type { FpLine, FpProject, FpTone } from "./types";

/** A project as the catalog shows it: its verification, plus how many units stand at each tone. */
export type FpProjectCard = FpProject & { tones: Record<FpTone, number> };

/**
 * Every project with where its units stand, for the module's front page.
 * Two reads, however many projects: the projects, then every unit at once,
 * judged by `disposition` like every other screen so no two can disagree.
 */
export async function listProjectCatalog(): Promise<FpProjectCard[]> {
  const [projects, rows] = await Promise.all([
    listProjectViews(),
    prisma.fpEquipment.findMany({ include: { updatedBy: { select: { firstName: true, lastName: true } } } }),
  ]);
  const byProject = new Map<string, FpLine[]>();
  for (const r of rows) {
    const key = r.projectId.toString();
    const list = byProject.get(key) ?? [];
    list.push(toLine(r));
    byProject.set(key, list);
  }
  return projects.map((p) => ({ ...p, tones: toneCounts(byProject.get(p.id) ?? []) }));
}
