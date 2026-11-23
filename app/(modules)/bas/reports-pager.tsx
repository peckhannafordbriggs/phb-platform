"use client";

import { Button } from "@/components/ui";
import { describePageRange } from "@/lib/modules/bas/reports/paging";

/**
 * The foot of a paged Reports list (2026-11-23): "1–25 of 30" on the left,
 * Previous and Next on the right, each greyed at its end. Drawn whenever the
 * list holds anything, a single page included, so the count is always on
 * screen. The page itself lives in the URL; this only asks for another.
 */
export function ListPager({
  page,
  pageSize,
  total,
  label,
  onPage,
}: {
  page: number;
  pageSize: number;
  total: number;
  /** What the pager pages, for a screen reader: "Reports pages". */
  label: string;
  onPage?: (page: number) => void;
}) {
  if (total <= 0) return null;
  const lastPage = Math.max(1, Math.ceil(total / pageSize));
  return (
    <nav
      aria-label={label}
      className="flex items-center justify-between gap-3 border-t border-[var(--divider-soft)] px-4 py-2.5 text-[0.8125rem]"
      data-testid="list-pager"
    >
      <span className="tabular-nums text-[var(--muted)]" data-testid="list-pager-range">
        {describePageRange(page, pageSize, total)}
      </span>
      <div className="flex gap-1.5">
        <Button size="sm" disabled={page <= 1 || onPage === undefined} onClick={() => onPage?.(page - 1)} testId="list-pager-previous">
          Previous
        </Button>
        <Button size="sm" disabled={page >= lastPage || onPage === undefined} onClick={() => onPage?.(page + 1)} testId="list-pager-next">
          Next
        </Button>
      </div>
    </nav>
  );
}
