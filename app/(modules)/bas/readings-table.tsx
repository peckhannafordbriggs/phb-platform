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
import {
  ApiError,
  describeNoReadings,
  fetchPointReadings,
  formatCount,
  formatTimestamp,
} from "./health-client";

/**
 * The raw readings behind the chart, as rows.
 *
 * This exists for one question: "the chart looks wrong - what is actually
 * stored?" So every row is a stored row (`ReadingRow`, all three value
 * columns), the order is newest first, the timestamp is the chart tooltip's
 * own formatter in the chart's own zone so a row and a point match by eye,
 * and the value is the stored value with its unit symbol - never the rounded
 * reading the tooltip shows, never a bucket's average. A state point's rows
 * read as its words, the same words as its axis; a string point's rows are
 * the stored strings.
 *
 * Mounted only while the toggle says "table", so a person on the chart never
 * makes this request. Fetches on mount and whenever the point, the range or
 * the page changes; a poll that moves a preset's window moves the table with
 * it, quietly, keeping the rows up while the next page loads.
 */

export interface ReadingsTableProps {
  point: PointOption;
  range: TrendRange;
  extent: PointExtent;
  /** Called with the range's total whenever a page arrives, for the heading. */
  onTotal?: (total: number) => void;
}

/**
 * The stored value as the row shows it, by the point's kind.
 *
 * The kind's own column first: a state as its word, a string verbatim, a
 * number as JavaScript prints it (shortest round-trip, so `72.02734375` is
 * shown whole) with the unit symbol through the one formatter. When the
 * kind's column is empty and another is not - a `real` point with a stray
 * boolean row, a collector defect - the stray value is shown raw rather than
 * hidden behind a dash, because a dash would say "null record" about a row
 * that is not one. A row with nothing in any column is "—", as on the tiles.
 */
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
  // The kind's column is empty. Whatever IS stored, shown as stored.
  if (row.valueNum !== null) return String(row.valueNum);
  if (row.valueBool !== null) return String(row.valueBool);
  if (row.valueStr !== null) return row.valueStr;
  return "—";
}

export function ReadingsTable({ point, range, extent, onTotal }: ReadingsTableProps) {
  const [data, setData] = useState<PointReadingsPage | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(true);

  // A new point or range starts at page 1: page 12 of one range is not a
  // place in another. The page is remembered WITH the selection it belongs
  // to, so a change of selection reads as page 1 in the same render and
  // never fetches the old page first.
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
        // The server clamps a page past the end; follow it, so the pager
        // and the rows agree about where we are.
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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the selection is keyed by selectionKey
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
        <table className="w-full border-collapse text-sm" data-testid="bas-readings-table">
          <thead className="sticky top-0 z-10 bg-[var(--surface)] text-left">
            <tr>
              <th className="px-3 py-2 font-medium">Time</th>
              <th className="px-3 py-2 text-right font-medium">Value</th>
            </tr>
          </thead>
          <tbody>
            {data.rows.map((row) => (
              <tr key={row.ts} className="border-t border-[var(--border)]">
                <td
                  className="px-3 py-1.5 text-[var(--muted)] tabular-nums"
                  // The exact stored instant, for matching against the CSV.
                  title={row.ts}
                >
                  {formatTimestamp(row.ts, undefined, zone)}
                </td>
                <td className="px-3 py-1.5 text-right tabular-nums" data-testid="bas-reading-value">
                  {renderStoredReading(row, point.valueKind, point.unit, point.states)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <nav
        className="flex flex-wrap items-center justify-between gap-2 border-t border-[var(--border)] px-4 py-2 text-xs text-[var(--muted)]"
        aria-label="Readings pages"
      >
        <span data-testid="bas-readings-position">
          {formatCount(first)}–{formatCount(last)} of {formatCount(data.total)}, newest first
        </span>
        <span className="flex items-center gap-1">
          <PagerButton label="First" disabled={data.page <= 1} onClick={() => setPage(1)} />
          <PagerButton
            label="Previous"
            disabled={data.page <= 1}
            onClick={() => setPage(data.page - 1)}
          />
          <span className="px-1 tabular-nums" data-testid="bas-readings-page">
            Page {formatCount(data.page)} of {formatCount(data.pages)}
          </span>
          <PagerButton
            label="Next"
            disabled={data.page >= data.pages}
            onClick={() => setPage(data.page + 1)}
          />
          <PagerButton
            label="Last"
            disabled={data.page >= data.pages}
            onClick={() => setPage(data.pages)}
          />
        </span>
      </nav>
    </>
  );
}

function PagerButton({
  label,
  disabled,
  onClick,
}: {
  label: string;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="rounded border border-[var(--border)] bg-[var(--neutral-0)] px-2 py-0.5 text-[0.6875rem] hover:bg-[var(--neutral-100)] disabled:cursor-default disabled:opacity-40 disabled:hover:bg-[var(--neutral-0)]"
    >
      {label}
    </button>
  );
}
