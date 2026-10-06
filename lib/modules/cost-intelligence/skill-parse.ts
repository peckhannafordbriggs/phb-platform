/**
 * Pure parsing for skill folders: no filesystem, no database, so every rule here
 * can be tested with a string.
 */

export type SkillFrontmatter = { name: string; description: string };

export type FrontmatterResult =
  | { ok: true; value: SkillFrontmatter }
  | { ok: false; reason: string };

/**
 * Reads `name` and `description` from the block between the first two `---`
 * lines of a SKILL.md.
 *
 * Handles the four ways the skills folder writes a value: plain, "double
 * quoted", 'single quoted' ('' is a literal '), and folded blocks (`>`, `>-`,
 * `|`). Whitespace is collapsed to single spaces, because the catalog shows the
 * description as one line.
 */
export function parseFrontmatter(source: string): FrontmatterResult {
  const lines = source.replace(/^﻿/, "").split(/\r?\n/);
  if (lines[0]?.trim() !== "---") {
    return { ok: false, reason: "SKILL.md does not start with a --- block" };
  }

  const end = lines.findIndex((line, i) => i > 0 && line.trim() === "---");
  if (end === -1) {
    return { ok: false, reason: "SKILL.md has no closing --- line" };
  }

  const block = lines.slice(1, end);
  const name = readKey(block, "name");
  const description = readKey(block, "description");

  if (name === null || name.length === 0) {
    return { ok: false, reason: "SKILL.md has no name" };
  }
  if (description === null || description.length === 0) {
    return { ok: false, reason: "SKILL.md has no description" };
  }
  return { ok: true, value: { name, description } };
}

function readKey(block: string[], key: string): string | null {
  const start = block.findIndex((line) => line.startsWith(`${key}:`));
  if (start === -1) return null;

  const first = block[start]!.slice(key.length + 1).trim();

  // A folded or literal block: the value is every indented line that follows.
  if (/^[>|][+-]?$/.test(first)) {
    const body: string[] = [];
    for (const line of block.slice(start + 1)) {
      if (line.length > 0 && !/^\s/.test(line)) break;
      body.push(line.trim());
    }
    return collapse(body.join(" "));
  }

  if (first.startsWith('"')) {
    return collapse(readQuoted(block, start, first, '"'));
  }
  if (first.startsWith("'")) {
    return collapse(readQuoted(block, start, first, "'"));
  }
  return collapse(first);
}

/**
 * A quoted value, which YAML allows to continue onto following lines until the
 * closing quote.
 */
function readQuoted(block: string[], start: number, first: string, quote: '"' | "'"): string {
  let text = first.slice(1);
  let i = start;
  for (;;) {
    const close = findClosingQuote(text, quote);
    if (close !== -1) {
      text = text.slice(0, close);
      break;
    }
    i += 1;
    const next = block[i];
    if (next === undefined) break;
    text += ` ${next.trim()}`;
  }
  return quote === '"' ? unescapeDouble(text) : text.replace(/''/g, "'");
}

function findClosingQuote(text: string, quote: '"' | "'"): number {
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote === '"' && ch === "\\") {
      i += 1;
      continue;
    }
    if (ch === quote) {
      if (quote === "'" && text[i + 1] === "'") {
        i += 1;
        continue;
      }
      return i;
    }
  }
  return -1;
}

function unescapeDouble(text: string): string {
  return text.replace(/\\(["\\/nt])/g, (_, ch: string) =>
    ch === "n" ? "\n" : ch === "t" ? "\t" : ch,
  );
}

function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export type ChangelogSummary = {
  /** One per `## ` entry. Zero when the file has none. */
  entries: number;
  /** The newest date found across the entry headings, or null if none parsed. */
  newest: Date | null;
};

const MONTHS = [
  "january", "february", "march", "april", "may", "june",
  "july", "august", "september", "october", "november", "december",
];

/**
 * Counts the `## ` entries in a CHANGELOG.md and finds the newest date in their
 * headings.
 *
 * Every level-2 heading is an entry, dated or not (`## v1` is still a
 * version). `###` headings are notes inside an entry and are not counted.
 *
 * Dates appear as `2026-09-22`, `2026-06` (month only, read as the 1st) and
 * `June 30, 2026`. A heading can hold two (`2026-09-17 → 2026-09-22`); every
 * date counts toward the newest, and entries are not always in date order, so
 * the newest is a maximum rather than the first heading.
 *
 * Dates are midnight UTC, so a date-only value never shifts a day when shown.
 */
export function parseChangelog(source: string): ChangelogSummary {
  let entries = 0;
  let newest: Date | null = null;

  for (const line of source.split(/\r?\n/)) {
    if (!/^## (?!#)/.test(line)) continue;
    entries += 1;

    for (const date of datesIn(line)) {
      if (newest === null || date.getTime() > newest.getTime()) newest = date;
    }
  }

  return { entries, newest };
}

function datesIn(text: string): Date[] {
  const found: Date[] = [];

  for (const m of text.matchAll(/\b(\d{4})-(\d{2})(?:-(\d{2}))?\b/g)) {
    const date = utcDate(Number(m[1]), Number(m[2]), m[3] === undefined ? 1 : Number(m[3]));
    if (date !== null) found.push(date);
  }

  for (const m of text.matchAll(/\b([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})\b/g)) {
    const month = MONTHS.indexOf(m[1]!.toLowerCase());
    if (month === -1) continue;
    const date = utcDate(Number(m[3]), month + 1, Number(m[2]));
    if (date !== null) found.push(date);
  }

  return found;
}

function utcDate(year: number, month: number, day: number): Date | null {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  // Rejects dates like 2026-02-31, which Date.UTC would roll into March.
  return date.getUTCMonth() === month - 1 ? date : null;
}
