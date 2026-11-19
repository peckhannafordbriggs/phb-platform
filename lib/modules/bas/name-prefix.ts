/**
 * What a point's NAME says about the equipment it belongs to (2026-11-19).
 *
 * Pure, and imported by the browser as well as the service: no Prisma, no
 * environment. NOTHING HERE WRITES. The Points list shows what this module
 * derives as a preview; a module admin edits it and confirms it; the service
 * recomputes it from the database at that moment and only then writes. Since
 * 2026-11-19 the automatic assignment pass (auto-assign.ts) also creates the
 * equipment for every row `groupIncludedByDefault` ticks - a unit of a known
 * type - with no preview, so a row in PREFIX_TYPE_RULES with a type is
 * equipment the platform creates by itself; I/O modules and unknown prefixes
 * still wait for a person.
 *
 * WHY THIS EXISTS. The first customer building, CEI's JACE `CEI_JCI_N2`, has
 * 334 points whose names carry their equipment before a slash -
 * `V4_22/SpaceTemp`, `AHU_7/DA_T` - and some with no slash but a leading unit
 * token, `VAV_10_ZoneTemperature`. Attaching 334 points one picker at a time
 * is the work this removes. The office's names (`VAV-2 122-125_ZoneTemperature`,
 * `Outside_Air_Temp_Analog_Input1`) follow a different convention, and the
 * office is the canon: this module must derive the office's ten VAVs exactly
 * as they were named by hand on 17 September, and nothing else.
 *
 * THE THREE WAYS A NAME CAN NAME ITS EQUIPMENT, in the order they are tried:
 *
 *   1. A slash. Everything before the LAST slash is a path; the segment just
 *      before it is the candidate (`Floor2/V4_22/SpaceTemp` -> `V4_22`), and
 *      everything after it is the tail the role suggestions read.
 *   2. An I/O module before the slash. `XTM_109/AHU_7_FinalFilter`: an XTM is
 *      a Johnson Controls expansion I/O module - a box of terminals - and the
 *      points on it belong to whatever it is wired to. When the tail starts
 *      with a unit token (`AHU_7_`), THAT is the equipment, and the module is
 *      ignored. When it does not, the module is offered with no type, so a
 *      person decides; it is never offered as a piece of equipment by default.
 *   3. A leading unit token with no slash: `VAV_10_ZoneTemperature`,
 *      `VAV-2 122-125_ZoneTemperature`, `AHU_7_DA_T`, `RTU_1_...`. Only the
 *      letters in LEADING_TOKEN_LETTERS count, and only with a number: `VAV_Box`
 *      and `AHU_SAT` name no unit.
 *
 * THE NAME IS WRITTEN AS THE INTEGRATOR WROTE IT. `V4_22` stays `V4_22`, the
 * office's `VAV-3` stays `VAV-3`: that is the string a controls technician
 * searches Workbench for. A person can rename any row in the preview.
 *
 * TWO SPELLINGS, ONE UNIT. `AHU_7`, `AHU-7`, `AHU 7` and `AHU7` are the same
 * air handler, so equipment is matched by `equipmentKey`, never by the raw
 * string - against the building's existing equipment, and between the rows of
 * one preview. Separators between DIGITS are kept: `V4_22` and `V42_2` are
 * different boxes, and so are `V4_22` and `V422`.
 */

/** Why the preview proposes a type, or why it proposes none. */
export interface PrefixTypeRule {
  /** The prefix's leading letters, upper case. */
  letters: string;
  /** null: the preview asks. */
  equipType: string | null;
  /** An I/O module: its points belong to whatever it is wired to. */
  ioModule: boolean;
  /** One sentence, shown on the preview row. */
  reason: string;
}

/**
 * The prefix letters this module knows, and what each means. Anything not
 * here is offered with no type, and a person picks one or leaves the row
 * out. CHOSEN, every row - correct them against the building, not here in
 * the abstract; a row is added when a real building's names justify it.
 */
export const PREFIX_TYPE_RULES: readonly PrefixTypeRule[] = [
  {
    letters: "V",
    equipType: "vav",
    ioModule: false,
    reason: "V followed by a number is a VAV box (the CEI convention, V4_22).",
  },
  {
    letters: "VAV",
    equipType: "vav",
    ioModule: false,
    reason: "VAV followed by a number is a VAV box.",
  },
  {
    letters: "AHU",
    equipType: "ahu",
    ioModule: false,
    reason: "AHU followed by a number is an air handling unit.",
  },
  {
    letters: "RTU",
    equipType: "rtu",
    ioModule: false,
    reason: "RTU followed by a number is a rooftop unit.",
  },
  {
    letters: "XTM",
    equipType: null,
    ioModule: true,
    reason:
      "XTM is a Johnson Controls expansion I/O module, not a piece of equipment: its points belong to whatever it is wired to. Choose a type only if this really is one unit.",
  },
  {
    letters: "IOM",
    equipType: null,
    ioModule: true,
    reason:
      "IOM is a Johnson Controls input/output module, not a piece of equipment: its points belong to whatever it is wired to. Choose a type only if this really is one unit.",
  },
];

/** Letters that name a unit at the START of a name with no slash. */
export const LEADING_TOKEN_LETTERS: readonly string[] = ["VAV", "AHU", "RTU"];

const UNKNOWN_PREFIX_REASON =
  "The name does not say what kind of equipment this is. Choose a type, or leave the row out.";

/**
 * The key two spellings of one unit share. Upper case; any run of `-`, `_`,
 * space or `.` becomes one `-`; a separator between a letter and a digit is
 * dropped. `AHU_7` / `AHU-7` / `ahu 7` / `AHU7` -> `AHU7`; `V4_22` -> `V4-22`;
 * `V42_2` -> `V42-2`; `VAV-2` -> `VAV2`.
 */
export function equipmentKey(name: string): string {
  return name
    .trim()
    .toUpperCase()
    .replace(/[-_ .]+/g, "-")
    .replace(/([A-Z])-(?=\d)/g, "$1")
    .replace(/^-+|-+$/g, "");
}

/** `AHU_7` -> `AHU`; `V4_22` -> `V`; `XTM_109` -> `XTM`; `N2Trunk` -> `N`. */
function leadingLetters(prefix: string): string {
  return /^[A-Za-z]+/.exec(prefix)?.[0].toUpperCase() ?? "";
}

/** A unit token at the start of a string, with the separator after it. */
const LEADING_TOKEN = new RegExp(
  `^((?:${LEADING_TOKEN_LETTERS.join("|")})[-_ ]?\\d{1,3}[A-Za-z]?)(?![0-9A-Za-z])[-_ ]+(?=\\S)`,
  "i",
);

export interface ParsedPointName {
  /** The equipment as the name writes it: `V4_22`, `AHU_7`, `VAV-3`. Null: the name names none. */
  prefix: string | null;
  /** equipmentKey(prefix). */
  key: string | null;
  /** How the prefix was found. */
  source: "slash" | "leading_token" | "after_io_module" | null;
  /** The I/O module the point sits on, when the prefix is one or was skipped over. */
  ioModule: string | null;
  /**
   * What the role suggestions read: everything after the prefix. The whole
   * name when there is no prefix. NOT the text after the last underscore -
   * `DA_T`, `OA_T`, `RA_HUM` and `DA_SAP` all contain one, and the last
   * segment of each (`T`, `T`, `HUM`, `SAP`) says much less than the whole.
   */
  tail: string;
}

/**
 * Split a point's decoded name into the equipment it names and the rest.
 * Pure; the cases are in tests/bas-name-prefix.test.ts with the real CEI
 * and office names.
 */
export function parsePointName(name: string): ParsedPointName {
  const trimmed = name.trim();
  const none: ParsedPointName = {
    prefix: null,
    key: null,
    source: null,
    ioModule: null,
    tail: trimmed,
  };

  const slash = trimmed.lastIndexOf("/");
  if (slash >= 0) {
    const tail = trimmed.slice(slash + 1).trim();
    const segments = trimmed.slice(0, slash).split("/");
    const prefix = (segments[segments.length - 1] ?? "").trim();
    // "/SpaceTemp" or "V4_22/" name nothing.
    if (prefix.length === 0 || tail.length === 0) return { ...none, tail: tail || trimmed };

    const rule = ruleFor(prefix);
    if (rule?.ioModule === true) {
      const inner = LEADING_TOKEN.exec(tail);
      if (inner !== null) {
        const token = inner[1]!;
        return {
          prefix: token,
          key: equipmentKey(token),
          source: "after_io_module",
          ioModule: prefix,
          tail: tail.slice(inner[0].length),
        };
      }
      return { prefix, key: equipmentKey(prefix), source: "slash", ioModule: prefix, tail };
    }
    return { prefix, key: equipmentKey(prefix), source: "slash", ioModule: null, tail };
  }

  const token = LEADING_TOKEN.exec(trimmed);
  if (token !== null) {
    const prefix = token[1]!;
    return {
      prefix,
      key: equipmentKey(prefix),
      source: "leading_token",
      ioModule: null,
      tail: trimmed.slice(token[0].length),
    };
  }
  return none;
}

function ruleFor(prefix: string): PrefixTypeRule | undefined {
  const letters = leadingLetters(prefix);
  // Letters alone are a word, not a unit: "Points/SpaceTemp" names no V.
  if (!/\d/.test(prefix)) return undefined;
  return PREFIX_TYPE_RULES.find((r) => r.letters === letters);
}

/** The type a prefix implies, and why. */
export function prefixType(prefix: string): {
  equipType: string | null;
  ioModule: boolean;
  reason: string;
} {
  const rule = ruleFor(prefix);
  if (rule === undefined) return { equipType: null, ioModule: false, reason: UNKNOWN_PREFIX_REASON };
  return { equipType: rule.equipType, ioModule: rule.ioModule, reason: rule.reason };
}

// ---------------------------------------------------------------------------
// The preview: one row per unit the station's names imply.
// ---------------------------------------------------------------------------

/** What the grouping needs to know about one point. */
export interface PrefixSubject {
  pointId: string;
  /** Niagara's display name, or the key with $-escapes decoded - the name a person reads. */
  name: string;
  collected: boolean;
  equipmentId: string | null;
}

export interface PrefixEquipmentFacts {
  equipmentId: string;
  name: string;
  equipType: string | null;
}

/**
 * One row of "Create N pieces of equipment from name prefixes".
 *
 * `pointIds` are the points the row would attach: collected, and with no
 * equipment today. A point that already has equipment is never in a row - it
 * is not moved by this, ever - and a row with no such point is not offered.
 */
export interface NamePrefixGroup {
  /** equipmentKey of the unit. What the confirm request names the row by. */
  key: string;
  /** The proposed name: the existing equipment's, else the commonest spelling. */
  name: string;
  /** Every spelling the names use, so a merge of AHU_7 and AHU-7 is visible. */
  spellings: string[];
  /** The proposed type, or null when the preview asks. */
  equipType: string | null;
  /** Why that type, or why none. */
  typeReason: string;
  /** True when the row is an I/O module rather than a unit. Off by default. */
  ioModule: boolean;
  /** Equipment on the building with this key, which the row attaches to instead of creating. */
  existing: PrefixEquipmentFacts | null;
  pointIds: string[];
  /** Up to three of the points' names, for the preview. */
  sampleNames: string[];
}

/** Rows a person would want ticked before they touch anything. */
export function groupIncludedByDefault(group: NamePrefixGroup): boolean {
  if (group.ioModule) return false;
  return group.existing !== null || group.equipType !== null;
}

const COLLATOR = new Intl.Collator("en", { numeric: true, sensitivity: "base" });

/**
 * Every unit the station's names imply that has at least one point to attach.
 * Pure, so the browser's preview and the service's confirm compute the same
 * rows from the same names.
 */
export function groupEquipmentPrefixes(
  points: readonly PrefixSubject[],
  existing: readonly PrefixEquipmentFacts[],
): NamePrefixGroup[] {
  const byKey = new Map<
    string,
    {
      spellings: Map<string, number>;
      /** Spellings found before a slash outrank one found as a token. */
      slashSpellings: Map<string, number>;
      ioModule: boolean;
      pointIds: string[];
      names: string[];
    }
  >();

  for (const point of points) {
    if (!point.collected || point.equipmentId !== null) continue;
    const parsed = parsePointName(point.name);
    if (parsed.prefix === null || parsed.key === null) continue;
    const entry = byKey.get(parsed.key) ?? {
      spellings: new Map<string, number>(),
      slashSpellings: new Map<string, number>(),
      ioModule: false,
      pointIds: [],
      names: [],
    };
    entry.spellings.set(parsed.prefix, (entry.spellings.get(parsed.prefix) ?? 0) + 1);
    if (parsed.source === "slash") {
      entry.slashSpellings.set(parsed.prefix, (entry.slashSpellings.get(parsed.prefix) ?? 0) + 1);
    }
    // A row is the module itself only when the module IS the prefix.
    if (parsed.source === "slash" && parsed.ioModule !== null) entry.ioModule = true;
    entry.pointIds.push(point.pointId);
    entry.names.push(point.name);
    byKey.set(parsed.key, entry);
  }

  const existingByKey = new Map<string, PrefixEquipmentFacts>();
  for (const e of existing) {
    const key = equipmentKey(e.name);
    if (!existingByKey.has(key)) existingByKey.set(key, e);
  }

  const commonest = (counts: Map<string, number>): string | null => {
    let best: string | null = null;
    let bestCount = -1;
    for (const [spelling, count] of [...counts.entries()].sort((a, b) => COLLATOR.compare(a[0], b[0]))) {
      if (count > bestCount) {
        best = spelling;
        bestCount = count;
      }
    }
    return best;
  };

  const groups: NamePrefixGroup[] = [];
  for (const [key, entry] of byKey) {
    const match = existingByKey.get(key) ?? null;
    const spelling = commonest(entry.slashSpellings.size > 0 ? entry.slashSpellings : entry.spellings)!;
    const type = prefixType(spelling);
    groups.push({
      key,
      name: match?.name ?? spelling,
      spellings: [...entry.spellings.keys()].sort(COLLATOR.compare),
      equipType: match !== null ? match.equipType : type.equipType,
      typeReason:
        match !== null
          ? `${match.name} already exists on this building; the points are attached to it.`
          : entry.ioModule
            ? prefixType(spelling).reason
            : type.reason,
      ioModule: match === null && entry.ioModule,
      existing: match,
      pointIds: entry.pointIds,
      sampleNames: [...entry.names].sort(COLLATOR.compare).slice(0, 3),
    });
  }

  // Units a type is proposed for first, then the ones that ask; by name within.
  return groups.sort((a, b) => {
    const rank = (g: NamePrefixGroup) => (groupIncludedByDefault(g) ? 0 : 1);
    return rank(a) - rank(b) || COLLATOR.compare(a.name, b.name);
  });
}
