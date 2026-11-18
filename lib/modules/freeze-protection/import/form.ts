import { isDateOnly } from "../dates";
import { NAME_MAX, TEXT_MAX } from "../result";
import type { FormImportRow } from "../schemas";
import type { CoilType, EquipmentStatus, Exposure, Protection, YesNo } from "../types";

/**
 * The Freeze Protection verification form: a fillable PDF a field team fills
 * in offline (assets/fp-verification-form.pdf, built by scripts/fp-build-form.py)
 * and uploads through the same Import as an equipment schedule.
 *
 * The import tells the two apart by the form's hidden `fp_form` field, read
 * before any page text, so a form never reaches the schedule split and a
 * drawing never reaches this parser. Everything below is a contract with the
 * build script; tests/fp-form.test.ts opens the committed PDF and checks the
 * field names and dropdown choices match.
 *
 * Pure: field values in, rows and problems out. No I/O.
 */

export const FORM_MARKER_FIELD = "fp_form";
export const FORM_MARKER_VALUE = "phb-fp-form/v1";
/** Printed in every page header. A flattened copy keeps the text but loses the fields. */
export const FORM_PRINTED_MARK = "PHB-FP-FORM v1";
/** Two pages of ten. More units means a second form, imported the same way (Karthik, 2026-11-10). */
export const FORM_ROWS = 20;

/** Dropdown text on the form -> stored value. Keys are what a person picks; order is the form's order. */
export const FORM_CHOICES = {
  coil: { Water: "water", Glycol: "glycol", Steam: "steam", None: "none" } satisfies Record<string, CoilType>,
  status: {
    "Not installed": "not_installed",
    "Installed, dry": "dry",
    "Installed, filled": "filled",
    "In service": "service",
  } satisfies Record<string, EquipmentStatus>,
  exposure: { Yes: "yes", No: "no", Unknown: "unknown" } satisfies Record<string, Exposure>,
  protection: {
    "Manual reset": "manual",
    "Auto reset": "auto",
    "Software only": "software",
    Glycol: "glycol",
    Drainable: "drainable",
    None: "none",
    Unknown: "unknown",
  } satisfies Record<string, Protection>,
  yesNo: { Yes: "yes", No: "no" } satisfies Record<string, YesNo>,
};

export const FORM_HEADER_FIELDS = ["job_number", "project_name", "tested_by", "test_date"] as const;

/** One row's fields: suffix on the form (`r07_coil`) and which dropdown, or null for free text. */
export const FORM_COLUMNS = [
  { key: "name", choices: null },
  { key: "type", choices: null },
  { key: "area", choices: null },
  { key: "coil", choices: "coil" },
  { key: "status", choices: "status" },
  { key: "exposure", choices: "exposure" },
  { key: "protection", choices: "protection" },
  { key: "fan", choices: "yesNo" },
  { key: "damper", choices: "yesNo" },
  { key: "valve", choices: "yesNo" },
  { key: "reset", choices: "yesNo" },
  { key: "trip", choices: null },
  { key: "notes", choices: null },
] as const satisfies readonly { key: string; choices: keyof typeof FORM_CHOICES | null }[];

export const formField = (row: number, key: (typeof FORM_COLUMNS)[number]["key"]) => `r${String(row).padStart(2, "0")}_${key}`;

/** What a person reads for each importable field, in the summary's lists and table. */
export const FORM_FIELD_LABEL: Record<keyof Omit<FormImportRow, "name">, string> = {
  equipmentType: "Type",
  areaServed: "Area served",
  coil: "Coil",
  status: "Status",
  exposure: "OA exposure",
  protection: "Protection",
  testFanStops: "Fan stops",
  testDamperCloses: "OA damper closes",
  testValveFullFlow: "Valve full flow",
  testManualReset: "Manual reset",
  tripTempF: "Trip °F",
  testedBy: "Tested by",
  testDate: "Test date",
  notes: "Notes",
};

export interface ParsedForm {
  /** From page 1. When filled, the import refuses a project with a different job number. */
  jobNumber: string | null;
  projectName: string | null;
  rows: FormImportRow[];
  /** Plain sentences, row numbers included, for anything left out or not understood. */
  problems: string[];
}

const blank = (v: string | undefined) => {
  const t = (v ?? "").replace(/\s+/g, " ").trim();
  return t === "" ? null : t;
};
const clip = (v: string | null, max: number) => (v === null ? null : v.slice(0, max));

/**
 * The form's answers as rows the commit route accepts. Tested by and test date
 * are asked once on page 1 and apply to every row with a test answer or a trip
 * temperature; a row with neither gets neither, so an untested unit never
 * looks tested.
 */
export function parseForm(fields: Record<string, string>): ParsedForm {
  const problems: string[] = [];
  const testedBy = clip(blank(fields.tested_by), NAME_MAX);
  const rawTestDate = blank(fields.test_date);
  const testDate = rawTestDate === null ? null : parseFormDate(rawTestDate);
  if (rawTestDate !== null && testDate === null) problems.push(`Test date "${rawTestDate}" is not a date, so no test date was recorded. Use YYYY-MM-DD.`);

  const rows: FormImportRow[] = [];
  const seen = new Set<string>();
  for (let n = 1; n <= FORM_ROWS; n++) {
    const raw = Object.fromEntries(FORM_COLUMNS.map((c) => [c.key, blank(fields[formField(n, c.key)])])) as Record<
      (typeof FORM_COLUMNS)[number]["key"],
      string | null
    >;
    if (Object.values(raw).every((v) => v === null)) continue;
    const name = clip(raw.name, NAME_MAX);
    if (name === null) {
      problems.push(`Row ${n} has answers but no name, so it was left out.`);
      continue;
    }
    if (seen.has(name.toLowerCase())) {
      problems.push(`Row ${n} repeats ${name}, so only the first row for it was read.`);
      continue;
    }
    seen.add(name.toLowerCase());

    const pick = <K extends keyof typeof FORM_CHOICES>(key: (typeof FORM_COLUMNS)[number]["key"], list: K, label: string) => {
      const v = raw[key];
      if (v === null) return null;
      const value = choice(FORM_CHOICES[list], v);
      if (value === null) problems.push(`Row ${n} (${name}): "${v}" is not a choice for ${label}, so it was left blank.`);
      return value as (typeof FORM_CHOICES)[K][keyof (typeof FORM_CHOICES)[K]] | null;
    };

    let tripTempF: number | null = null;
    if (raw.trip !== null) {
      const m = /-?\d+(?:\.\d+)?/.exec(raw.trip);
      const t = m ? Number(m[0]) : NaN;
      if (Number.isFinite(t) && t >= -40 && t <= 120) tripTempF = t;
      else problems.push(`Row ${n} (${name}): trip temperature "${raw.trip}" is not a temperature in °F, so it was left blank.`);
    }

    const row: FormImportRow = {
      name,
      equipmentType: clip(raw.type, NAME_MAX),
      areaServed: clip(raw.area, NAME_MAX),
      coil: pick("coil", "coil", "coil"),
      status: pick("status", "status", "status"),
      exposure: pick("exposure", "exposure", "OA exposure"),
      protection: pick("protection", "protection", "protection"),
      testFanStops: pick("fan", "yesNo", "fan stops"),
      testDamperCloses: pick("damper", "yesNo", "OA damper closes"),
      testValveFullFlow: pick("valve", "yesNo", "valve full flow"),
      testManualReset: pick("reset", "yesNo", "manual reset"),
      tripTempF,
      testedBy: null,
      testDate: null,
      notes: clip(raw.notes, TEXT_MAX),
    };
    const tested = [row.testFanStops, row.testDamperCloses, row.testValveFullFlow, row.testManualReset, row.tripTempF].some((v) => v !== null);
    if (tested) {
      row.testedBy = testedBy;
      row.testDate = testDate;
    }
    rows.push(row);
  }

  return { jobNumber: clip(blank(fields.job_number), NAME_MAX), projectName: clip(blank(fields.project_name), NAME_MAX), rows, problems };
}

/** The dropdown text, or the stored value itself, ignoring case: another viewer may write either. */
function choice(map: Record<string, string>, value: string): string | null {
  const v = value.toLowerCase();
  for (const [label, stored] of Object.entries(map)) if (label.toLowerCase() === v || stored === v) return stored;
  return null;
}

/** YYYY-MM-DD, or a US date as people write one (11/9/2026, 11-09-26). Null when it is not a real day. */
export function parseFormDate(value: string): string | null {
  const v = value.trim();
  if (isDateOnly(v)) return v;
  const m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})$/.exec(v);
  if (!m) return null;
  const year = m[3]!.length === 2 ? `20${m[3]}` : m[3]!;
  const iso = `${year}-${m[1]!.padStart(2, "0")}-${m[2]!.padStart(2, "0")}`;
  return isDateOnly(iso) ? iso : null;
}
