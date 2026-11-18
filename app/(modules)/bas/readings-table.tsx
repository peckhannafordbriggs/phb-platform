"use client";

import { useEffect, useState } from "react";
import type {
  PointExtent,
  PointOption,
  PointReadingsPage,
  ReadingRow,
  TrendRange,
} from "@/lib/modules/bas/types";
import { withUnit } from "@/lib/modules/bas/units";
import { stateWord, type BooleanStates, type ValueKind } from "@/lib/modules/bas/value-kind";
import { Button } from "@/components/ui";
import {
  ApiError,
  describeNoReadings,
  fetchPointReadings,
  formatCount,
  formatTimestamp,
} from "./health-client";

/**
 * The readings table behind the chart (2026-10-09): the STORED rows for the
 * same point over the very two instants the chart's response carries, newest
 * first, 200 a page. Never bucketed - a separate path from the chart's series,
 * importing nothing from it. A boolean row is its state word, a numeric row
 * is the stored value whole with the unit symbol, and a timestamp is the
 * tooltip's format in the building's zone with the exact instant as its title.
 */

export interface ReadingsTableProps {
  point: PointOption;
  range: TrendRange;
  extent: PointExtent;
  onTotal?: (total: number) => void;
}

/** The stored value as text: the state word, the string, or the number with its unit. */
export function renderStoredReading(
  row: ReadingRow,
  kind: ValueKind,
  unit: string | null,
  states: BooleanStates | null,
): string {
  if (kind === "boolean" && row.valueBool !== null) {
    return stateWord(row.valueBool ? 1 : 0, states ?? { on: "True", off: "False" }) ?? "—";
  }
  if (kind === "string" && row.valueStr !== null) return row.valueStr;
  if (kind === "numeric" && row.valueNum !== null) return withUnit(String(row.valueNum), unit);
  if (row.valueNum !== null) return String(row.valueNum);
  if (row.valueBool !== null) return String(row.valueBool);
  if (row.valueStr !== null) return row.valueStr;
  return "—";
}

export function ReadingsTable({ point, range, extent, onTotal }: ReadingsTableProps) {
  const [data, setData] = useState<PointReadingsPage | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(true);

  // The page belongs to one selection; a new point or range starts at page 1.
  const selectionKey = `${point.pointId}|${range.from}|${range.to}`;
  const [pageFor, setPageFor] = useState<{ key: string; page: number }>({
    key: selectionKey,
    page: 1,
  });
  const page = pageFor.key === selectionKey ? pageFor.page : 1;
  const setPage = (next: number) => setPageFor({ key: selectionKey, page: next });

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    void (async () => {
      try {
        const next = await fetchPointReadings(
          { pointId: point.pointId, from: range.from, to: range.to, page },
          controller.signal,
        );
        setData(next);
        setError(null);
        if (next.page !== page) setPage(next.page);
        onTotal?.(next.total);
      } catch (caught) {
        if (caught instanceof DOMException && caught.name === "AbortError") return;
        setError(
          caught instanceof ApiError ? caught : new ApiError("unexpected", "Something went wrong."),
        );
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the key is the selection; the callbacks are the parent's
  }, [selectionKey, page]);

  if (error !== null && data === null) {
    return (
      <p className="px-4 py-8 text-center text-sm text-red-900" role="alert">
        {error.message}
      </p>
    );
  }

  if (data === null) {
    return (
      <div className="h-24 animate-pulse" aria-busy="true" data-testid="bas-readings-loading" />
    );
  }

  if (data.total === 0) {
    return (
      <p
        className="px-4 py-8 text-center text-sm text-[var(--muted)]"
        data-testid="bas-no-readings"
      >
        {describeNoReadings(point.pointName, range, extent)}
      </p>
    );
  }

  const zone = range.timezone ?? data.timezone;
  const first = (data.page - 1) * data.pageSize + 1;
  const last = first + data.rows.length - 1;

  return (
    <>
      {error !== null && (
        <p className="border-b border-red-300 bg-red-50 px-4 py-2 text-xs text-red-900" role="alert">
          The last page did not load. Showing the previous one.
        </p>
      )}
      {/* The one scroll box: about seven rows, a sticky header. */}
      <div className="max-h-72 overflow-auto" aria-busy={loading}>
        <table className="w-full border-collapse text-[0.8125rem]" data-testid="bas-readings-table">
          <thead className="sticky top-0 z-10 bg-[var(--surface)] text-left">
            <tr>
              <th className="eyebrow px-3 py-2.5 text-[var(--muted)]">Time</th>
              <th className="eyebrow px-3 py-2.5 text-right text-[var(--muted)]">Value</th>
            </tr>
          </thead>
          <tbody>
            {data.rows.map((row) => (
              <tr key={row.ts} className="border-t border-[var(--divider-soft)]">
                <td
                  className="px-3 py-2 text-[var(--muted)] tabular-nums"
                  title={row.ts}
                >
                  {formatTimestamp(row.ts, undefined, zone)}
                </td>
                <td className="px-3 py-2 text-right tabular-nums" data-testid="bas-reading-value">
                  {renderStoredReading(row, point.valueKind, point.unit, point.states)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <nav
        className="flex flex-wrap items-center justify-between gap-2 border-t border-[var(--divider-soft)] px-4 py-2.5 text-xs text-[var(--muted)]"
        aria-label="Readings pages"
      >
        <span data-testid="bas-readings-position">
          {formatCount(first)}–{formatCount(last)} of {formatCount(data.total)}, newest first
        </span>
        <span className="flex items-center gap-1">
          <Button size="sm" disabled={data.page <= 1} onClick={() => setPage(1)}>
            First
          </Button>
          <Button size="sm" disabled={data.page <= 1} onClick={() => setPage(data.page - 1)}>
            Previous
          </Button>
          <span className="px-1 tabular-nums" data-testid="bas-readings-page">
            Page {formatCount(data.page)} of {formatCount(data.pages)}
          </span>
          <Button size="sm" disabled={data.page >= data.pages} onClick={() => setPage(data.page + 1)}>
            Next
          </Button>
          <Button size="sm" disabled={data.page >= data.pages} onClick={() => setPage(data.pages)}>
            Last
          </Button>
        </span>
      </nav>
    </>
  );
}
