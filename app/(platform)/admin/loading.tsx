/**
 * The admin list while it loads.
 *
 * PHASE-10: "Loading states that don't shift layout." A spinner that is replaced
 * by a table moves everything on the page the moment the data lands, which at
 * this size means the row somebody was about to click moves out from under the
 * pointer. So this occupies the space the real thing is about to take: the same
 * header, the same filter bar height, and a full page of row-shaped blocks.
 *
 * `pageSize` defaults to 25, so 25 rows is what the list will almost always
 * settle into.
 */
export default function AdminLoading() {
  return (
    <div aria-busy="true" aria-live="polite">
      <span className="sr-only">Loading employees…</span>

      <header className="flex items-baseline justify-between">
        <h1 className="text-xl font-semibold">Admin</h1>
      </header>

      <p className="mt-2 text-sm text-[var(--muted)]">
        Everyone who has ever signed in appears here. Granting a module is what
        gives access; there is no way to create an employee.
      </p>

      {/* The filter bar's height, held so the table below does not jump. */}
      <div className="mt-6 h-[3.25rem] animate-pulse rounded bg-[var(--surface)]" />

      <div className="mt-4 h-4 w-40 animate-pulse rounded bg-[var(--surface)]" />

      <div className="mt-2 overflow-hidden rounded border border-[var(--border)]">
        <div className="h-9 border-b border-[var(--border)] bg-[var(--surface)]" />
        {Array.from({ length: 25 }, (_, i) => (
          <div
            key={i}
            className="flex items-center gap-4 border-b border-[var(--border)] px-3 py-2.5 last:border-b-0"
          >
            <div className="h-3.5 w-3.5 shrink-0 rounded-sm bg-[var(--surface)]" />
            <div className="h-3 w-40 animate-pulse rounded bg-[var(--surface)]" />
            <div className="h-3 w-52 animate-pulse rounded bg-[var(--surface)]" />
            <div className="h-3 w-28 animate-pulse rounded bg-[var(--surface)]" />
            <div className="ml-auto h-3 w-20 animate-pulse rounded bg-[var(--surface)]" />
          </div>
        ))}
      </div>
    </div>
  );
}
