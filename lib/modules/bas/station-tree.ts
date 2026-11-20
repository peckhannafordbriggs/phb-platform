/**
 * Stations in the order a person reads a building: each station, then the
 * stations whose history it imports, indented under it (2026-11-20).
 *
 * Since the collector reads via-parent stations through their parent
 * (phb-bas, collector/targets.py), CEI_AHU_7, CEI_AHU_8 and CEI_PLANT are
 * stations of their own with their own runs and points - and they are
 * meaningful only beside CEI_JCI_N2, whose connection carries them. Every
 * list of JACEs on the BAS screens (the Collection Health and Point Explorer
 * pickers, the Collection Health stations panel, the Reports station picker)
 * orders them with this one function, so the tree is the same tree wherever
 * it is drawn.
 *
 * Pure and dependency-free: the client components import it as well as the
 * services.
 *
 * Rules:
 *   - A ROOT is a station whose parent is not in the list - no parent, or a
 *     parent outside the current filter (a child on another building than its
 *     JACE, filtered to its own building, is a root there). Roots keep the
 *     order the caller already used: building name, then station name.
 *   - Children follow their parent, by name, recursively; `depth` counts the
 *     levels below the root.
 *   - A loop (A -> B -> A, which the Settings form refuses but a hand-written
 *     row could hold) never hangs and never drops a row: whatever the walk
 *     could not place is appended at depth 0.
 */

export interface StationTreeRow {
  stationId: string;
  parentStationId: string | null;
  name: string;
  siteName: string;
}

export type Placed<T> = T & {
  /** Levels below the root of its tree in this list. 0 for a root. */
  depth: number;
  /** The parent's name when the parent is in this list, else null. */
  parentName: string | null;
};

export function orderStationTree<T extends StationTreeRow>(rows: readonly T[]): Placed<T>[] {
  const byId = new Map(rows.map((row) => [row.stationId, row]));
  const children = new Map<string, T[]>();
  const roots: T[] = [];

  for (const row of rows) {
    const parent = row.parentStationId;
    if (parent !== null && parent !== row.stationId && byId.has(parent)) {
      const list = children.get(parent) ?? [];
      list.push(row);
      children.set(parent, list);
    } else {
      roots.push(row);
    }
  }
  for (const list of children.values()) {
    list.sort((a, b) => a.name.localeCompare(b.name) || a.stationId.localeCompare(b.stationId));
  }

  const out: Placed<T>[] = [];
  const placed = new Set<string>();

  const visit = (row: T, depth: number) => {
    if (placed.has(row.stationId)) return;
    placed.add(row.stationId);
    const parentName =
      row.parentStationId !== null && byId.has(row.parentStationId) && depth > 0
        ? byId.get(row.parentStationId)!.name
        : null;
    out.push({ ...row, depth, parentName });
    for (const child of children.get(row.stationId) ?? []) visit(child, depth + 1);
  };

  for (const root of roots) visit(root, 0);
  // A loop has no root; its members are still listed, flat, rather than lost.
  for (const row of rows) visit(row, 0);
  return out;
}
