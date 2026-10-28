/**
 * Reads what the curated file names say. Every file in a curated project
 * follows the naming sheet (Rulebook v3.0), e.g.
 *
 *   224070_SUB_Air_Valves_Approved_20241121.pdf
 *   ARCHIVE_224070_SUB_Air_Valves_Rejected_20240119.pdf
 *   210733_SPEC_23_07_19_HVAC_Piping_Insulation_v02.docx
 *
 * so a version group ("family") is the name with the ARCHIVE_ prefix, the
 * status word and the date or version stripped. All versions of the Air
 * Valves submittal share `224070_SUB_Air_Valves`, and the newest
 * non-archived one is the one answers lead with.
 *
 * Names that do not follow the sheet still get a family (the whole stem), so
 * they simply have no other versions. Nothing here is a guess about content.
 *
 * Subcontracts file the signed and unsigned copy under one date
 * (`..._Executed_20240110.pdf` beside `..._Unexecuted_20240110.pdf`), so a
 * tie on the date is broken by the status word: see STATUS_RANK.
 */

/**
 * Status words the naming sheet puts before the date, compared
 * case-insensitively, with the rank that breaks a tie on the date: a signed
 * or approved copy is the current one over an unsigned, pending or rejected
 * copy of the same date. A name with no status word ranks with `pending`.
 */
const STATUS_RANK: Readonly<Record<string, number>> = {
  executed: 3,
  approved: 3,
  pending: 1,
  unexecuted: 1,
  rejected: 0,
};
const NO_STATUS_RANK = 1;

export interface KbParsedName {
  /** The version-group key, e.g. `224070_SUB_Air_Valves`. */
  familyKey: string;
  /** `v02`, or the date as written (`20241121`), or null. */
  versionLabel: string | null;
  /** Sort key for the version: a date as YYYYMMDD, or a version number. Larger is newer. */
  versionRank: number | null;
  /** `Approved`, `Rejected`, ... as written, or null. */
  status: string | null;
  archived: boolean;
}

export function parseFileName(fileName: string): KbParsedName {
  const dot = fileName.lastIndexOf(".");
  let stem = dot > 0 ? fileName.slice(0, dot) : fileName;

  const archived = /^ARCHIVE_/i.test(stem);
  if (archived) stem = stem.slice("ARCHIVE_".length);

  const parts = stem.split("_");
  let versionLabel: string | null = null;
  let versionRank: number | null = null;
  let status: string | null = null;

  const last = parts.at(-1) ?? "";
  if (/^\d{8}$/.test(last)) {
    versionLabel = last;
    versionRank = Number(last);
    parts.pop();
  } else if (/^v\d{1,3}$/i.test(last)) {
    versionLabel = last.toLowerCase();
    versionRank = Number(last.slice(1));
    parts.pop();
  }

  const maybeStatus = parts.at(-1) ?? "";
  if (parts.length > 1 && Object.hasOwn(STATUS_RANK, maybeStatus.toLowerCase())) {
    status = maybeStatus;
    parts.pop();
  }

  return {
    familyKey: parts.join("_"),
    versionLabel,
    versionRank,
    status,
    archived,
  };
}

export interface KbVersionCandidate {
  /** Anything that identifies the file to the caller; also the last tie-break. */
  path: string;
  parsed: KbParsedName;
}

/**
 * The current version of one family: the newest non-archived member, by
 * version rank, then status (STATUS_RANK), then path so the choice is
 * stable. Null when every member is archived - the family has no current
 * version, and nothing in it may be marked latest.
 */
export function pickLatest<T extends KbVersionCandidate>(members: readonly T[]): T | null {
  let best: T | null = null;
  for (const member of members) {
    if (member.parsed.archived) continue;
    if (best === null || compareVersions(member, best) > 0) best = member;
  }
  return best;
}

function statusRank(status: string | null): number {
  const key = status?.toLowerCase() ?? "";
  return Object.hasOwn(STATUS_RANK, key) ? (STATUS_RANK[key] ?? NO_STATUS_RANK) : NO_STATUS_RANK;
}

/** Positive when `a` is newer than `b`. */
function compareVersions(a: KbVersionCandidate, b: KbVersionCandidate): number {
  const rankA = a.parsed.versionRank ?? -1;
  const rankB = b.parsed.versionRank ?? -1;
  if (rankA !== rankB) return rankA - rankB;
  const statusDiff = statusRank(a.parsed.status) - statusRank(b.parsed.status);
  if (statusDiff !== 0) return statusDiff;
  // The lexically first path wins, so the choice never depends on listing order.
  return a.path < b.path ? 1 : a.path > b.path ? -1 : 0;
}
