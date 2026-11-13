import { buildInviteEmail } from "@/lib/admin/invite-email";
import { AdminActions, AdminShell } from "./admin-shell";

/**
 * The admin list while it loads.
 *
 * PHASE-10: "Loading states that don't shift layout." A spinner that is replaced
 * by a table moves everything on the page the moment the data lands, which at
 * this size means the row somebody was about to click moves out from under the
 * pointer. So this occupies the space the real thing is about to take: the same
 * shell with the same header actions, a card the filter bar's height, and a
 * card holding a full page of row-shaped blocks.
 *
 * `pageSize` defaults to 25, so 25 rows is what the list will almost always
 * settle into.
 */
export default function AdminLoading() {
  return (
    <AdminShell actions={<AdminActions email={buildInviteEmail()} />}>
      <div aria-busy="true" aria-live="polite" className="flex flex-col gap-5">
        <span className="sr-only">Loading employees…</span>

        {/* The filter card's height, held so the table below does not jump. */}
        <div className="card p-5">
          <div className="h-[3.75rem] animate-pulse rounded-[var(--radius-control)] bg-[var(--surface)]" />
          <div className="mt-3 h-4 w-40 animate-pulse rounded bg-[var(--surface)]" />
        </div>

        <div className="card p-5">
          <div className="h-8 border-b border-[var(--border)]" />
          {Array.from({ length: 25 }, (_, i) => (
            <div
              key={i}
              className="flex items-center gap-4 border-b border-[var(--divider-soft)] py-3.5 last:border-b-0"
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
    </AdminShell>
  );
}
