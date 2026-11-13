"use client";

import { Fragment, useState } from "react";

/**
 * A table with equal-width columns. Pass `pageSize` to paginate; omit it to show every row.
 * `onRowClick` and `selected` both use the row's index in `rows`, not its index on the page.
 *
 * Two additions for the Admin Employees list (2026-11-13), each absent by
 * default so every table drawn before renders the markup it rendered:
 *
 *   - `columns`: a `grid-template-columns` value, for a table whose columns
 *     are not equal - a chevron and a checkbox beside a name beside a row of
 *     chips. Equal widths when omitted.
 *   - `detail`: what to draw beneath a row, full width, when the caller has
 *     expanded it. The caller owns the expanded state and the control that
 *     toggles it (a chevron in a cell); the table only draws the panel, on
 *     the row's own divider, in the neutral ground the kit's lists use.
 */
export function Table({
  headers,
  rows,
  pageSize,
  onRowClick,
  selected,
  columns,
  detail,
}: {
  /** Column headings. Usually text; can hold a control such as a `FilterMenu`. */
  headers: React.ReactNode[];
  rows: React.ReactNode[][];
  pageSize?: number;
  onRowClick?: (index: number) => void;
  selected?: number;
  /** A `grid-template-columns` value. Equal widths when omitted. */
  columns?: string;
  /** The panel under the row at `index` in `rows`, or null / undefined for none. */
  detail?: (index: number) => React.ReactNode;
}) {
  const [page, setPage] = useState(0);
  const pageCount = pageSize ? Math.max(1, Math.ceil(rows.length / pageSize)) : 1;
  const offset = pageSize ? page * pageSize : 0;
  const visible = pageSize ? rows.slice(offset, offset + pageSize) : rows;
  const grid = { gridTemplateColumns: columns ?? `repeat(${headers.length}, minmax(0, 1fr))` };

  return (
    <div>
      <div className="grid gap-4 border-b border-[var(--border)] pb-3" style={grid}>
        {headers.map((h, i) => (
          <span key={i} className="eyebrow text-[var(--muted)]">
            {h}
          </span>
        ))}
      </div>

      {visible.map((row, i) => {
        const index = offset + i;
        const panel = detail?.(index);
        return (
          <Fragment key={index}>
            <div
              onClick={onRowClick ? () => onRowClick(index) : undefined}
              className={
                "grid items-center gap-4 border-b border-[var(--divider-soft)] py-3.5 text-[0.8125rem] " +
                (onRowClick ? "cursor-pointer hover:bg-[var(--neutral-50)] " : "") +
                (selected === index ? "bg-[var(--neutral-50)] font-medium" : "")
              }
              style={grid}
            >
              {row.map((cell, j) => (
                <div key={j} className="min-w-0 truncate">
                  {cell}
                </div>
              ))}
            </div>
            {panel !== null && panel !== undefined && panel !== false && (
              <div className="border-b border-[var(--divider-soft)] py-3">
                <div className="rounded-[var(--radius-row)] bg-[var(--neutral-50)] px-4 py-4 text-[0.8125rem]">{panel}</div>
              </div>
            )}
          </Fragment>
        );
      })}

      {pageSize && pageCount > 1 && (
        <div className="flex items-center justify-end gap-3 pt-3 text-[0.8125rem] text-[var(--muted)]">
          <button type="button" onClick={() => setPage(page - 1)} disabled={page === 0} className="disabled:opacity-40">
            Previous
          </button>
          <span>
            {page + 1} / {pageCount}
          </span>
          <button type="button" onClick={() => setPage(page + 1)} disabled={page === pageCount - 1} className="disabled:opacity-40">
            Next
          </button>
        </div>
      )}
    </div>
  );
}
