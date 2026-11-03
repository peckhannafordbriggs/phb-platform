import type { CoilType } from "../types";

/** One run of text on a page, in reading coordinates: x right, y down, y at the baseline. h is the font size. */
export interface PdfItem {
  x: number;
  y: number;
  w: number;
  h: number;
  s: string;
}

export interface PdfPage {
  page: number;
  width: number;
  height: number;
  items: PdfItem[];
}

/** One schedule (or one slice of a long one) cut out of the drawing set, as layout text. */
export interface ScheduleBlock {
  key: string;
  page: number;
  /** The drawing's sheet number from the title block, e.g. M-701-R, when it can be read. */
  sheet: string | null;
  title: string;
  /** "rows 1 to 100 of 240" when a long schedule was sliced; null otherwise. */
  part: string | null;
  text: string;
  /** Distinct mark-like first cells (AHU-1, FPB-2-03). A floor for how many rows the schedule has. */
  marks: number;
}

export type ExposureSuggestion = "likely" | "unlikely";

export const FLAG_NOT_FOUND = "Name not found in the schedule text";
export const FLAG_FROM_LIST = "From a row naming several units";

/** One unit as the import proposes it, after the deterministic checks. */
export interface ImportRow {
  name: string;
  equipmentType: string | null;
  areaServed: string | null;
  coil: CoilType;
  exposureSuggestion: ExposureSuggestion | null;
  exposureEvidence: string | null;
  /** Why a reviewer should look twice; empty when nothing stood out. */
  flags: string[];
}

export interface AnalyzedSchedule {
  key: string;
  page: number;
  sheet: string | null;
  title: string;
  part: string | null;
  /** The model's call: is this a schedule of equipment, or of accessories (diffusers, valves, attenuators)? */
  isEquipment: boolean;
  reason: string;
  rows: ImportRow[];
  /** Schedule-level notes for the reviewer, e.g. "found 70 of about 79 marked rows". */
  warnings: string[];
}
