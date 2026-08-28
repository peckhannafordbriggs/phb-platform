/**
 * The audit log while it loads.
 *
 * Same reasoning as the employee list's: the filter bar and the rows hold their
 * space so nothing moves when the data arrives. `pageSize` defaults to 50 here,
 * but 12 placeholder rows is enough to fill a viewport without pretending to
 * know how many the filters will return.
 */
export default function AuditLoading() {
  return (
    <div aria-busy="true" aria-live="polite">
      <span className="sr-only">Loading the audit log…</span>

      <div className="h-5 w-32 rounded bg-[var(--surface)]" />
      <h1 className="mt-4 text-xl font-semibold">Audit log</h1>
      <div className="mt-2 h-10 max-w-2xl animate-pulse rounded bg-[var(--surface)]" />
      <div className="mt-6 h-[3.25rem] animate-pulse rounded bg-[var(--surface)]" />
      <div className="mt-4 h-4 w-32 animate-pulse rounded bg-[var(--surface)]" />

      <div className="mt-2 overflow-hidden rounded border border-[var(--border)]">
        {Array.from({ length: 12 }, (_, i) => (
          <div key={i} className="border-b border-[var(--border)] px-4 py-3 last:border-b-0">
            <div className="h-3.5 w-2/3 animate-pulse rounded bg-[var(--surface)]" />
            <div className="mt-2 h-2.5 w-40 animate-pulse rounded bg-[var(--surface)]" />
          </div>
        ))}
      </div>
    </div>
  );
}
