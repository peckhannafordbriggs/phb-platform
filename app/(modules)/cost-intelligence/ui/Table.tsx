"use client";

import { useState } from "react";

/**
 * A table with equal-width columns. Pass `pageSize` to paginate; omit it to show every row.
 * `onRowClick` and `selected` both use the row's index in `rows`, not its index on the page.
 */
export function Table({
  headers,
  rows,
  pageSize,
  onRowClick,
  selected,
}: {
  headers: string[];
  rows: React.ReactNode[][];
  pageSize?: number;
  onRowClick?: (index: number) => void;
  selected?: number;
}) {
  const [page, setPage] = useState(0);
  const pageCount = pageSize ? Math.max(1, Math.ceil(rows.length / pageSize)) : 1;
  const offset = pageSize ? page * pageSize : 0;
  const visible = pageSize ? rows.slice(offset, offset + pageSize) : rows;
  const grid = { gridTemplateColumns: `repeat(${headers.length}, minmax(0, 1fr))` };

  return (
    <div>
      <div className="grid gap-4 border-b border-[var(--border)] pb-3" style={grid}>
        {headers.map((h) => (
          <span key={h} className="eyebrow text-[var(--muted)]">
            {h}
          </span>
        ))}
      </div>

      {visible.map((row, i) => (
        <div
          key={offset + i}
          onClick={onRowClick ? () => onRowClick(offset + i) : undefined}
          className={
            "grid items-center gap-4 border-b border-[var(--divider-soft)] py-3.5 text-[0.8125rem] " +
            (onRowClick ? "cursor-pointer hover:bg-[var(--neutral-50)] " : "") +
            (selected === offset + i ? "bg-[var(--neutral-50)] font-medium" : "")
          }
          style={grid}
        >
          {row.map((cell, j) => (
            <div key={j} className="min-w-0 truncate">
              {cell}
            </div>
          ))}
        </div>
      ))}

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
