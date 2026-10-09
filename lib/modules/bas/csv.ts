/**
 * The readings export as text: RFC 4180, nothing cleverer.
 *
 * Pure. The route streams what `csvLine` produces; the test compares its
 * output with the rows it inserted, byte for byte. Every rule here is a
 * decision the file's reader - Excel, usually - will hold us to:
 *
 *  - `\r\n` between records, because RFC 4180 says so and Excel on Windows
 *    agrees. The LAST record carries it too, so a file is a whole number of
 *    records and two exports concatenate cleanly.
 *  - A field is quoted when, and only when, it holds a comma, a quote, a
 *    carriage return or a line feed; a quote inside is doubled. A point's
 *    label is free text and somebody will put a comma in one.
 *  - A NULL is an empty field, not the word "null". A null record (a row the
 *    station logged with nothing in it - docs/08, *A null reading is not a
 *    missing reading*) is a row whose `value` is empty, and it is in the file,
 *    because it is in the database.
 *  - No byte-order mark. Excel reads a BOM-less UTF-8 file as the system code
 *    page, so a non-ASCII label may show wrong there; but a BOM breaks the
 *    header of every parser that does not expect one, and the file's job is
 *    to be traced back to rows, not to look right in one program.
 *
 * The value is the STORED value: a number as JavaScript prints it (shortest
 * round-trip form, so `72.02734375` stays `72.02734375`), a boolean as `true`
 * or `false`, a string verbatim. Not the state word and not the rounded
 * reading the screen shows - a person opening this file is checking the
 * screen against the database, and a file that repeated the screen's display
 * choices could not do that. The `unit` column is the stored unit name
 * (`fahrenheit`), not its symbol, for the same reason.
 */

import type { ReadingRow } from "./types";

export const CSV_RECORD_SEPARATOR = "\r\n";

/**
 * The columns, in order. `timestamp` is the instant exactly as stored -
 * UTC, six fractional digits - and the rest are what a person needs to find
 * the row again: the point by its three names and its id, the station by
 * name and id. `status` is in the schema and always NULL on this extraction
 * path (prisma/schema.prisma, `BasReading.status`); it is here because it is
 * stored, and empty because it is not supplied.
 */
export const CSV_COLUMNS = [
  "timestamp",
  "value",
  "unit",
  "point_name",
  "niagara_history_name",
  "point_id",
  "station",
  "station_id",
  "status",
] as const;

/** What every row of one export shares. */
export interface CsvPointContext {
  pointId: string;
  pointName: string;
  niagaraHistoryName: string;
  unit: string | null;
  stationId: string;
  stationName: string;
}

export function csvField(value: string | number | boolean | null): string {
  if (value === null) return "";
  const text = typeof value === "string" ? value : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** The stored value, whichever column holds it, or null for a null record. */
export function storedValue(row: ReadingRow): string | number | boolean | null {
  if (row.valueNum !== null) return row.valueNum;
  if (row.valueBool !== null) return row.valueBool;
  return row.valueStr;
}

export function csvHeader(): string {
  return CSV_COLUMNS.join(",") + CSV_RECORD_SEPARATOR;
}

export function csvLine(row: ReadingRow, point: CsvPointContext): string {
  return (
    [
      csvField(row.ts),
      csvField(storedValue(row)),
      csvField(point.unit),
      csvField(point.pointName),
      csvField(point.niagaraHistoryName),
      csvField(point.pointId),
      csvField(point.stationName),
      csvField(point.stationId),
      csvField(row.status),
    ].join(",") + CSV_RECORD_SEPARATOR
  );
}

/**
 * `readings-<point>-<from>-<to>.csv`, safe for every filesystem: the point's
 * shown name with anything outside letters, digits, dot and dash collapsed to
 * one underscore, and the two instants to the minute with the separators
 * removed - `2026-09-11T14:05:00.000Z` becomes `20260911T1405Z`.
 */
export function csvFilename(pointName: string, from: string, to: string): string {
  const stamp = (iso: string) =>
    iso.replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z").replace(/T(\d{4})\d{2}Z$/, "T$1Z");
  const name = pointName.replace(/[^A-Za-z0-9.-]+/g, "_").replace(/^_+|_+$/g, "");
  return `readings-${name.length > 0 ? name : "point"}-${stamp(from)}-${stamp(to)}.csv`;
}
