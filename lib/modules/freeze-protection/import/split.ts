import type { PdfItem, PdfPage, ScheduleBlock } from "./types";

/**
 * Cuts a mechanical schedule sheet into its schedules, deterministically.
 *
 * A sheet holds a dozen tables laid out in two dimensions, each under a title
 * set larger than the body text ("FAN COIL UNIT SCHEDULE"). The steps:
 *
 * 1. Body size is the most common font size; titles are upper-case runs set
 *    1.5 to 2.6 times larger, outside the title block on the right edge.
 * 2. Text that sits close together (a few characters across, about a line
 *    down) is joined into islands. A table is usually one island; a table
 *    with wide column gaps is several.
 * 3. Each island holding a title starts a schedule. Islands without one join
 *    the schedule beside them (same rows) or just above them (same columns),
 *    nearest first, until nothing moves. What joins nothing (the title block,
 *    general notes, key plans) is dropped.
 * 4. Each schedule is written back out as fixed-width text, columns kept in
 *    place, so a dash under "HOT WATER COIL" stays under it.
 *
 * Long schedules are sliced (header repeated) so no one model call is huge.
 * Pure: no I/O, so tests feed it items directly.
 */

const TITLE_MIN = 1.5;
const TITLE_MAX = 2.6;
/** The title block: CAD sheets keep it on the right edge. */
const TITLE_BLOCK_FROM = 0.88;
const SLICE_OVER = 140;
const SLICE_SIZE = 100;

/** A first cell that looks like an equipment mark: AHU-1, DS-AHU-R1A, FPB-2-03, EF1, P-1A. */
export const MARK = /^(?=[A-Z0-9.\-/]{2,24}$)(?=.*\d)[A-Z][A-Z0-9]*(?:[-./][A-Z0-9]+)*$/;

interface Island {
  items: PdfItem[];
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  titles: PdfItem[];
}

function mode(values: number[]): number {
  const counts = new Map<number, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  let best = 10;
  let n = 0;
  for (const [v, c] of counts) if (c > n) [best, n] = [v, c];
  return best;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
}

function bounds(items: PdfItem[]) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const i of items) {
    x0 = Math.min(x0, i.x);
    y0 = Math.min(y0, i.y - i.h);
    x1 = Math.max(x1, i.x + i.w);
    y1 = Math.max(y1, i.y);
  }
  return { x0, y0, x1, y1 };
}

/** Joins items whose padded boxes touch. Grid-bucketed, so a 7,000-item sheet stays quick. */
function islands(items: PdfItem[], dx: number, dy: number): PdfItem[][] {
  const parent = items.map((_, i) => i);
  const find = (a: number): number => {
    while (parent[a] !== a) {
      parent[a] = parent[parent[a]!]!;
      a = parent[a]!;
    }
    return a;
  };
  const box = items.map((i) => [i.x - dx, i.y - i.h - dy, i.x + i.w + dx, i.y + dy] as const);
  const cell = 64;
  const grid = new Map<string, number[]>();
  box.forEach((b, k) => {
    for (let gx = Math.floor(b[0] / cell); gx <= Math.floor(b[2] / cell); gx++) {
      for (let gy = Math.floor(b[1] / cell); gy <= Math.floor(b[3] / cell); gy++) {
        const key = `${gx}:${gy}`;
        const list = grid.get(key);
        if (list) list.push(k);
        else grid.set(key, [k]);
      }
    }
  });
  for (const list of grid.values()) {
    for (let a = 0; a < list.length; a++) {
      const A = box[list[a]!]!;
      for (let b = a + 1; b < list.length; b++) {
        const B = box[list[b]!]!;
        if (A[0] < B[2] && B[0] < A[2] && A[1] < B[3] && B[1] < A[3]) parent[find(list[a]!)] = find(list[b]!);
      }
    }
  }
  const groups = new Map<number, PdfItem[]>();
  items.forEach((item, k) => {
    const root = find(k);
    const g = groups.get(root);
    if (g) g.push(item);
    else groups.set(root, [item]);
  });
  return [...groups.values()];
}

/** Title runs on one baseline ("AIR HANDLING UNIT SCHEDULE" + "(PART A)") read as one title. */
function mergeTitles(titles: PdfItem[]): PdfItem[] {
  const sorted = [...titles].sort((a, b) => a.y - b.y || a.x - b.x);
  const out: PdfItem[] = [];
  for (const t of sorted) {
    const last = out[out.length - 1];
    if (last && Math.abs(last.y - t.y) < 2 && t.x - (last.x + last.w) < 3 * t.h && t.x >= last.x) {
      out[out.length - 1] = { ...last, w: t.x + t.w - last.x, s: `${last.s} ${t.s}` };
    } else out.push(t);
  }
  return out;
}

const looksLikeTitle = (i: PdfItem, body: number, width: number) =>
  i.h >= TITLE_MIN * body &&
  i.h <= TITLE_MAX * body &&
  i.x < TITLE_BLOCK_FROM * width &&
  (i.s.match(/[A-Z]/g)?.length ?? 0) >= 4 &&
  !/[a-z]/.test(i.s);

/** The sheet number in the title block, e.g. M-701-R: the largest sheet-number-shaped text on the right edge. */
function sheetNumber(page: PdfPage): string | null {
  let best: PdfItem | null = null;
  for (const i of page.items) {
    if (i.x < TITLE_BLOCK_FROM * page.width) continue;
    if (!/^[A-Z]{1,3}(-\d{1,4}|\d{3,4})(\.\d+)?(-[A-Z0-9]{1,4})?$/.test(i.s)) continue;
    if (best === null || i.h > best.h) best = i;
  }
  return best?.s ?? null;
}

/** Fixed-width text with columns kept where they are on the sheet. */
export function layoutText(items: PdfItem[], body: number): string[] {
  if (items.length === 0) return [];
  const charW = Math.max(1, median(items.filter((i) => i.s.length >= 2).map((i) => i.w / i.s.length)) || body * 0.5);
  const x0 = Math.min(...items.map((i) => i.x));
  const sorted = [...items].sort((a, b) => a.y - b.y || a.x - b.x);
  const rows: PdfItem[][] = [];
  let lineY = -Infinity;
  for (const i of sorted) {
    if (i.y - lineY > body * 0.5) {
      rows.push([]);
      lineY = i.y;
    }
    rows[rows.length - 1]!.push(i);
  }
  return rows.map((row) => {
    let line = "";
    for (const i of row.sort((a, b) => a.x - b.x)) {
      const col = Math.round((i.x - x0) / charW);
      line = line.length < col ? line.padEnd(col) : line.length > 0 ? `${line} ` : line;
      line += i.s;
    }
    return line.trimEnd();
  });
}

/**
 * The first cell of a line. Drafting software sometimes splits a mark with a
 * stray space ("SAV-DS 1-920" for SAV-DS1-920), so a first word that is not a
 * mark but becomes one with the next word glued on counts as that mark.
 */
export function firstCell(line: string): string {
  const [a = "", b = ""] = line.trim().split(/\s+/);
  if (!MARK.test(a) && /[A-Z]$/.test(a) && /^\d/.test(b) && MARK.test(a + b)) return a + b;
  return a;
}

function sliceLines(lines: string[]): { lines: string[]; part: string | null }[] {
  if (lines.length <= SLICE_OVER) return [{ lines, part: null }];
  const firstMark = lines.findIndex((l) => MARK.test(firstCell(l)));
  if (firstMark <= 0) return [{ lines, part: null }];
  const header = lines.slice(0, firstMark);
  const body = lines.slice(firstMark);
  const out: { lines: string[]; part: string | null }[] = [];
  let start = 0;
  while (start < body.length) {
    let end = Math.min(body.length, start + SLICE_SIZE);
    // End a slice just before a marked row, so a unit's wrapped lines stay together.
    while (end < body.length && end > start + SLICE_SIZE / 2 && !MARK.test(firstCell(body[end]!))) end--;
    out.push({ lines: [...header, ...body.slice(start, end)], part: `lines ${start + 1} to ${end} of ${body.length}` });
    start = end;
  }
  return out;
}

export function splitPage(page: PdfPage): ScheduleBlock[] {
  const items = page.items;
  if (items.length === 0) return [];
  const body = mode(items.map((i) => Math.round(i.h * 2) / 2));
  const sheet = sheetNumber(page);
  const groups = islands(items, 3 * body, 1.2 * body);

  const all: Island[] = groups.map((g) => {
    const titles = g.filter((i) => looksLikeTitle(i, body, page.width));
    const bodyCount = g.length - titles.length;
    const real = titles.filter((t) => /\bSCHEDULE\b/.test(t.s) || bodyCount >= 15);
    return { items: g, ...bounds(g), titles: mergeTitles(real) };
  });

  // An island with two titles (two schedules stacked tight) is split: each
  // item goes to the nearest title above it, preferring one over its columns.
  const blocks: Island[] = [];
  const loose: Island[] = [];
  for (const island of all) {
    if (island.titles.length === 0) {
      if (island.items.length >= 2) loose.push(island);
      continue;
    }
    if (island.titles.length === 1) {
      blocks.push(island);
      continue;
    }
    const parts = island.titles.map((t) => ({ title: t, items: [] as PdfItem[] }));
    for (const item of island.items) {
      const above = parts.filter((p) => p.title.y <= item.y + 1);
      const pool = above.length > 0 ? above : parts;
      pool.sort((a, b) => {
        const over = (p: typeof a) => (item.x + item.w >= p.title.x - 400 && item.x <= p.title.x + p.title.w + 400 ? 0 : 1);
        return over(a) - over(b) || b.title.y - a.title.y;
      });
      pool[0]!.items.push(item);
    }
    for (const p of parts) blocks.push({ items: p.items, ...bounds(p.items), titles: [p.title] });
  }

  // Loose islands join the schedule beside or above them, nearest first.
  const reach = 15 * body;
  let moved = true;
  while (moved && loose.length > 0) {
    moved = false;
    for (let k = loose.length - 1; k >= 0; k--) {
      const isl = loose[k]!;
      let best: Island | null = null;
      let bestGap = Infinity;
      for (const b of blocks) {
        const yOverlap = Math.min(isl.y1, b.y1) - Math.max(isl.y0, b.y0);
        const xOverlap = Math.min(isl.x1, b.x1) - Math.max(isl.x0, b.x0);
        let gap = Infinity;
        if (yOverlap >= 0.5 * (isl.y1 - isl.y0)) {
          gap = Math.max(0, isl.x0 > b.x1 ? isl.x0 - b.x1 : b.x0 - isl.x1);
        } else if (isl.y0 >= b.y0 && xOverlap >= 0.5 * (isl.x1 - isl.x0)) {
          gap = Math.max(0, isl.y0 - b.y1);
        }
        if (gap <= reach && gap < bestGap) [best, bestGap] = [b, gap];
      }
      if (best) {
        best.items.push(...isl.items);
        Object.assign(best, bounds(best.items));
        loose.splice(k, 1);
        moved = true;
      }
    }
  }

  blocks.sort((a, b) => a.titles[0]!.y - b.titles[0]!.y || a.titles[0]!.x - b.titles[0]!.x);
  const out: ScheduleBlock[] = [];
  blocks.forEach((b, n) => {
    const title = b.titles[0]!;
    const lines = layoutText(b.items, body);
    for (const [s, slice] of sliceLines(lines).entries()) {
      out.push({
        key: `p${page.page}-${n + 1}${s > 0 || slice.part ? `-${s + 1}` : ""}`,
        page: page.page,
        sheet,
        title: title.s,
        part: slice.part,
        text: slice.lines.join("\n"),
        marks: new Set(slice.lines.map(firstCell).filter((c) => MARK.test(c))).size,
      });
    }
  });
  return out;
}

export function splitSchedules(pages: PdfPage[]): ScheduleBlock[] {
  return pages.flatMap(splitPage);
}
