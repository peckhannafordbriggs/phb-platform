import { decorativeCardFill } from "@/lib/module-accent";

/**
 * Which brand fill a project's Dashboard card takes.
 *
 * BY CREATION ORDER, NOT DISPLAY ORDER. The cards are shown org-then-name,
 * and a project named "Aardvark Plaza" created next year would sort first and
 * - had colour followed position on screen - recolour every other card.
 * Ranking by `project_id` instead (a bigint that only ever grows) means a
 * new project takes the next colour and nobody else's changes, on every
 * machine that created its projects in the same order. Deleting a project
 * shifts the ones created after it by one; that is the trade, and it is the
 * rarer event by far.
 *
 * Deliberately takes the whole list rather than one id: the rank IS the
 * colour, and a rank needs the others to exist. Nothing about a project's
 * health, size or name is consulted, and tests/bas-dashboard-colours.test.ts
 * fails if that changes - a card whose colour followed its risk would make
 * colour semantic, which is the one thing it must never be here.
 */
export function projectFills(
  projects: ReadonlyArray<{ projectId: string }>,
): ReadonlyMap<string, string> {
  const byCreation = [...new Set(projects.map((p) => p.projectId))].sort(
    (a, b) => compareIds(a, b),
  );
  return new Map(byCreation.map((id, rank) => [id, decorativeCardFill(rank)]));
}

/** Numeric order for ids that arrive as decimal strings and may exceed 2^53. */
function compareIds(a: string, b: string): number {
  const [x, y] = [BigInt(a), BigInt(b)];
  return x < y ? -1 : x > y ? 1 : 0;
}
