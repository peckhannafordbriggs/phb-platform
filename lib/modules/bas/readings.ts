/**
 * The raw readings behind the Point Explorer chart: a paged table, and a CSV
 * of the whole range.
 *
 * A SEPARATE PATH FROM THE CHART, ON PURPOSE. `getPointExplorer` counts the
 * readings in the range and, past `MAX_RAW_TREND_POINTS` (range.ts), draws
 * one bucket per ladder rung instead of one point per reading. That cap is a
 * measurement of how many SVG path points Recharts can draw and zoom under
 * 400 ms; it says nothing about how many rows a table can page through or a
 * file can hold. So nothing here reads the cap, the ladder or the trend. The
 * table is `count(*)` over the range and a LIMIT/OFFSET slice of it, newest
 * first, in SQL; the CSV is a keyset walk over the same rows. When the chart
 * is showing 3,000 averages, the table shows the 70,000 readings they were
 * averaged from, and `tests/bas-readings-table.test.ts` holds it to that
 * over a fixture where the two would differ.
 *
 * THE RANGE IS TWO INSTANTS, NOT TWO DATES. The chart's response already
 * carries its range resolved - `range.from` and `range.to`, ISO, the end
 * exclusive, worked out by PostgreSQL in the building's zone (service.ts). The
 * table and the CSV ask for exactly those instants back, so "the same range
 * the chart is showing" is true by construction rather than by re-deriving a
 * calendar date in a second place, and a preset's trailing window does not
 * move between page 1 and page 2. The zone is still carried for DISPLAY: a
 * row's timestamp is shown through the same formatter as the chart's tooltip
 * in the same zone, so a row and a point can be matched by eye.
 *
 * WHO MAY SEE WHAT is the chart's rule, applied to one point: active, in a
 * building the employee is entitled to, and `is_visible` - a hidden point is
 * refused here with the chart's own sentence (`HIDDEN_POINT_MESSAGE`), so the
 * table can never show rows for a point the picker will not offer.
 *
 * NOTHING HERE RUNS ON PAGE LOAD. The explorer's response is unchanged; the
 * table fetches when it is shown and the CSV when it is asked for. A person
 * who never opens either costs nothing new.
 */

import { Prisma } from "@/lib/generated/prisma/client";
import type { Viewer } from "@/lib/authz";
import { prisma } from "@/lib/db";
import { logger } from "@/lib/logger";
import { BasError } from "./errors";
import { csvFilename, csvHeader, csvLine, type CsvPointContext } from "./csv";
import type { ParsedInput } from "./route-helpers";
import {
  HIDDEN_POINT_MESSAGE,
  POINT_NOT_AVAILABLE_MESSAGE,
  basSiteScope,
  parsePointId,
  resolveValueKind,
  shownPointName,
  siteFilter,
  toPointOption,
  type PointOptionRow,
} from "./service";
import type { PointReadingsPage, ReadingRow } from "./types";

/**
 * Rows per page of the table.
 *
 * Chosen for the round trip, not the screen: 200 rows is about 20 KB of JSON
 * and renders in well under a frame, and it is the same count the Analyze tab
 * caps a result at - the number of rows a person reads rather than scrolls
 * past. The biggest point today (`points_RoomT`, about 9,000 readings) is 45
 * pages; a 100,000-reading point is 500, and the pager jumps to any of them.
 * The box the rows sit in is the module's seven-row scroll box, so a page is
 * scrolled, then paged. OFFSET paging over the primary key `(point_id, ts)` is
 * an index walk, so the last page of a 100,000-row point costs the walk and
 * no more.
 */
export const READINGS_PAGE_SIZE = 200;

/**
 * The most rows one CSV export carries.
 *
 * 500,000 is one point at a one-minute cadence for 347 days, or at five
 * minutes for four and three-quarter years - above any single point this
 * database will hold for some time (the largest holds about 9,000 today), so
 * the cap is a bound and not a feature. Two things set it where it is:
 *
 *  - Excel opens 1,048,576 rows and silently drops the rest. A file that can
 *    never reach that limit can never be truncated AGAIN, quietly, by the
 *    program most likely to open it, after we have told the person exactly
 *    what we cut.
 *  - About 45 MB of CSV at 90 bytes a row, which a browser holds in memory as
 *    a Blob before it saves the file.
 *
 * The export is streamed in `EXPORT_CHUNK_ROWS` keyset chunks, so the
 * platform's memory does not scale with it; the cap bounds the file and the
 * request, not the server. When it bites, the NEWEST rows are kept - the same
 * end the chart keeps when it collects a folder to a cap - and the response
 * says so in headers the button reads out loud. Never silently.
 */
export const MAX_EXPORT_ROWS = 500_000;

/** Rows per query while streaming an export. Memory per chunk, not per file. */
export const EXPORT_CHUNK_ROWS = 10_000;

/**
 * The three headers a CSV response carries and the Download button reads. A
 * capped export is not an error - the file is real and complete up to the cap
 * - so the truth about it travels beside the file rather than instead of it,
 * and the button turns it into a sentence (`describeCappedExport`). Same
 * origin, so nothing needs exposing.
 */
export const TOTAL_HEADER = "X-PHB-Readings-Total";
export const EXPORTED_HEADER = "X-PHB-Readings-Exported";
export const CAP_HEADER = "X-PHB-Readings-Cap";

/** The instant as stored: UTC, six fractional digits, the `Z` spelled out. */
const TS_EXACT = Prisma.sql`to_char(ts AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

interface ReadingsPointRow extends PointOptionRow {
  is_visible: boolean;
  station_id: bigint;
  station_name: string;
}

interface RawReadingRow {
  ts: string;
  value_num: number | null;
  value_bool: boolean | null;
  value_str: string | null;
  status: string | null;
}

export interface ReadingsRequest {
  pointId: bigint;
  /** ISO instants. `from` inclusive, `to` exclusive - the chart's `range`. */
  from: string;
  to: string;
  /** 1-based. Clamped to the last page by the service. */
  page?: number;
}

export interface PointReadingsOptions extends ReadingsRequest {
  /** Test seam. Nothing in the application passes it. */
  pageSize?: number;
}

export interface ExportOptions extends ReadingsRequest {
  /** Test seams. Nothing in the application passes either. */
  maxRows?: number;
  chunkRows?: number;
}

/** What an export is, before a byte of it has been produced. */
export interface ReadingsExport {
  point: CsvPointContext;
  filename: string;
  /** Readings in the range. */
  total: number;
  /** Rows the file will hold: `min(total, cap)`. */
  exported: number;
  cap: number;
  /** The CSV, header first, in chunks of text. Runs the queries as it is read. */
  chunks: () => AsyncGenerator<string, void, undefined>;
}

// ------------------------------------------------------------ the request

const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/;

/**
 * An instant as the chart's payload spells it: ISO 8601, UTC, a `Z`. Nothing
 * else - no offsets, no bare dates - because the only honest source of these
 * values is the explorer's own `range`, and a hand-typed local time with no
 * zone would be resolved in whatever zone the server runs in.
 */
export function parseInstant(value: string, label: string): Date {
  if (!INSTANT.test(value) || Number.isNaN(Date.parse(value))) {
    throw new BasError(
      "invalid_range",
      `The ${label} instant "${value}" is not an ISO 8601 UTC timestamp.`,
    );
  }
  return new Date(value);
}

/**
 * The query string both routes accept: `point`, `from`, `to`, and for the
 * table `page`. Shape only, like the explorer route; whether the instants are
 * in order and whether the point may be seen are the service's to decide.
 */
export function parseReadingsQuery(
  search: URLSearchParams,
  options: { page: boolean },
): ParsedInput<ReadingsRequest> {
  const point = search.get("point")?.trim() ?? "";
  if (!/^[0-9]{1,32}$/.test(point)) {
    return { ok: false, message: "point must be a point id." };
  }
  const from = search.get("from")?.trim() ?? "";
  const to = search.get("to")?.trim() ?? "";
  if (!INSTANT.test(from) || !INSTANT.test(to)) {
    return { ok: false, message: "from and to must both be given, as ISO 8601 UTC instants." };
  }
  const request: ReadingsRequest = { pointId: parsePointId(point)!, from, to };
  if (options.page) {
    const raw = search.get("page");
    const page = raw === null ? 1 : Number(raw);
    if (!Number.isInteger(page) || page < 1 || page > 1_000_000) {
      return { ok: false, message: "page must be a whole number of 1 or more." };
    }
    request.page = page;
  }
  return { ok: true, data: request };
}

// -------------------------------------------------------------- the point

/**
 * The one point, with the chart's own three conditions, or the chart's own
 * refusal. The SELECT list is the picker's (`PointOptionRow`) so the point
 * comes back as the same `PointOption` the chart carries - the same kind, the
 * same state words - plus the station the CSV names.
 */
async function loadPoint(
  db: Prisma.TransactionClient,
  entitled: bigint[] | null,
  pointId: bigint,
): Promise<ReadingsPointRow> {
  const rows = await db.$queryRaw<ReadingsPointRow[]>`
    SELECT v.point_id,
           ${shownPointName(Prisma.sql`v`)} AS point_name,
           v.point_role, v.unit, v.site_name,
           v.collection_interval_s,
           s.timezone AS site_timezone,
           st.clock_offset_s, st.clock_measured_at,
           v.data_type, v.is_status, v.is_command, v.niagara_history_name,
           p.is_visible,
           st.station_id,
           COALESCE(st.display_name, st.niagara_station_name) AS station_name
    FROM bas_v_point v
    JOIN bas_points p USING (point_id)
    JOIN bas_stations st ON st.station_id = p.station_id
    JOIN bas_sites s ON s.site_id = st.site_id
    WHERE v.point_id = ${pointId}
      AND v.is_active
      AND ${siteFilter(entitled, Prisma.sql`st.site_id`)}
  `;
  const row = rows[0] ?? null;
  if (row === null) throw new BasError("point_not_found", POINT_NOT_AVAILABLE_MESSAGE);
  // Hidden rather than gone, said as such - the same sentence the chart uses,
  // because the fix is the same checkbox.
  if (!row.is_visible) throw new BasError("point_not_found", HIDDEN_POINT_MESSAGE);
  return row;
}

function resolveRange(request: ReadingsRequest): { from: Date; to: Date } {
  const from = parseInstant(request.from, "start");
  const to = parseInstant(request.to, "end");
  if (to.getTime() <= from.getTime()) {
    throw new BasError(
      "invalid_range",
      `The end (${request.to}) is not after the start (${request.from}).`,
    );
  }
  return { from, to };
}

function toReadingRow(row: RawReadingRow): ReadingRow {
  return {
    ts: row.ts,
    valueNum: row.value_num,
    valueBool: row.value_bool,
    valueStr: row.value_str,
    status: row.status,
  };
}

// --------------------------------------------------------------- the page

/**
 * One page of the readings in `[from, to)`, newest first.
 *
 * The count and the slice run in one transaction so a reading arriving
 * between them cannot make page 1 of 45 and "9,012 readings" disagree. The
 * page asked for is clamped to the last one rather than refused: a person on
 * page 45 whose range just shrank is shown the new last page, with the number
 * they are actually on in the payload.
 */
export async function getPointReadings(
  viewer: Viewer,
  options: PointReadingsOptions,
): Promise<PointReadingsPage> {
  const pageSize = options.pageSize ?? READINGS_PAGE_SIZE;
  if (!Number.isInteger(pageSize) || pageSize < 1) {
    throw new Error(`pageSize must be a positive integer, got ${String(pageSize)}`);
  }
  const { from, to } = resolveRange(options);
  const scope = await basSiteScope(viewer);

  const result = await prisma.$transaction(async (tx) => {
    const point = await loadPoint(tx, scope.entitled, options.pointId);
    const pointId = point.point_id;
    const valueKind = await resolveValueKind(tx, point.data_type, pointId, from, to);

    const total = (
      await tx.$queryRaw<Array<{ total: number }>>`
        SELECT count(*)::int AS total
        FROM bas_readings
        WHERE point_id = ${pointId} AND ts >= ${from} AND ts < ${to}
      `
    )[0]!.total;

    const pages = Math.max(1, Math.ceil(total / pageSize));
    const page = Math.min(Math.max(1, options.page ?? 1), pages);

    const rows = await tx.$queryRaw<RawReadingRow[]>`
      SELECT ${TS_EXACT} AS ts, value_num, value_bool, value_str, status
      FROM bas_readings
      WHERE point_id = ${pointId} AND ts >= ${from} AND ts < ${to}
      ORDER BY ts DESC
      LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}
    `;

    return { point, valueKind, total, pages, page, rows };
  });

  logger.info("bas.point_readings", {
    employeeId: scope.employeeId,
    moduleKey: "bas",
    count: result.rows.length,
    reason:
      `point=${result.point.point_id} range=${options.from}..${options.to} ` +
      `page=${result.page}/${result.pages} total=${result.total}`,
  });

  return {
    point: toPointOption(result.point, result.valueKind),
    stationId: result.point.station_id.toString(),
    stationName: result.point.station_name,
    niagaraHistoryName: result.point.niagara_history_name,
    timezone: result.point.site_timezone,
    from: options.from,
    to: options.to,
    total: result.total,
    page: result.page,
    pageSize,
    pages: result.pages,
    rows: result.rows.map(toReadingRow),
  };
}

// ------------------------------------------------------------ the export

/**
 * Every reading in `[from, to)` as CSV, newest first, up to the cap.
 *
 * The count and the point are settled before anything streams, because the
 * headers that say "N of M" have to leave before the body does. The rows are
 * then walked by KEYSET - `ts < last row's ts`, as the exact text PostgreSQL
 * printed, never as a JavaScript Date, which keeps three fractional digits
 * and would skip any row in the microseconds a truncated cursor jumped over.
 * Each chunk is one query of at most `chunkRows`; the file is never in
 * memory at once.
 *
 * Not in a transaction. An interactive transaction has a timeout and this
 * can legitimately take longer; the cost is that a reading backfilled into
 * the range while the file streams may or may not appear, which is the same
 * truth the table tells across two page loads.
 */
export async function exportPointReadings(
  viewer: Viewer,
  options: ExportOptions,
): Promise<ReadingsExport> {
  const cap = options.maxRows ?? MAX_EXPORT_ROWS;
  const chunkRows = options.chunkRows ?? EXPORT_CHUNK_ROWS;
  if (!Number.isInteger(cap) || cap < 1 || !Number.isInteger(chunkRows) || chunkRows < 1) {
    throw new Error("maxRows and chunkRows must be positive integers");
  }
  const { from, to } = resolveRange(options);
  const scope = await basSiteScope(viewer);

  const point = await loadPoint(prisma, scope.entitled, options.pointId);
  const pointId = point.point_id;
  const total = (
    await prisma.$queryRaw<Array<{ total: number }>>`
      SELECT count(*)::int AS total
      FROM bas_readings
      WHERE point_id = ${pointId} AND ts >= ${from} AND ts < ${to}
    `
  )[0]!.total;
  const exported = Math.min(total, cap);

  const context: CsvPointContext = {
    pointId: pointId.toString(),
    pointName: point.point_name,
    niagaraHistoryName: point.niagara_history_name,
    unit: point.unit,
    stationId: point.station_id.toString(),
    stationName: point.station_name,
  };

  logger.info("bas.readings_exported", {
    employeeId: scope.employeeId,
    moduleKey: "bas",
    count: exported,
    reason:
      `point=${pointId} range=${options.from}..${options.to} total=${total} ` +
      `cap=${cap}${total > cap ? " CAPPED" : ""}`,
  });

  async function* chunks(): AsyncGenerator<string, void, undefined> {
    yield csvHeader();
    let remaining = exported;
    // The first cursor is the range's own exclusive end; after that, the
    // last row sent, exactly as printed.
    let cursor: Prisma.Sql = Prisma.sql`${to}`;
    while (remaining > 0) {
      const limit = Math.min(chunkRows, remaining);
      const rows = await prisma.$queryRaw<RawReadingRow[]>`
        SELECT ${TS_EXACT} AS ts, value_num, value_bool, value_str, status
        FROM bas_readings
        WHERE point_id = ${pointId} AND ts >= ${from} AND ts < ${cursor}
        ORDER BY ts DESC
        LIMIT ${limit}
      `;
      if (rows.length === 0) break;
      yield rows.map((row) => csvLine(toReadingRow(row), context)).join("");
      remaining -= rows.length;
      cursor = Prisma.sql`${rows[rows.length - 1]!.ts}::timestamptz`;
    }
  }

  return {
    point: context,
    filename: csvFilename(point.point_name, options.from, options.to),
    total,
    exported,
    cap,
    chunks,
  };
}
