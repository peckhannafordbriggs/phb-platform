/**
 * The sub-tab that had nothing to show in Phase 1, saying so honestly.
 *
 * Not a "coming soon" card: it states what it will hold and why it is
 * empty, so a person who lands here knows whether to wait or to report a
 * fault. Pure, so a node test can assert the wording.
 *
 * The Usage placeholder that sat beside this one was retired on 2026-11-12:
 * it said "There have been no runs" without asking, and kept saying it
 * after runs existed. Usage is reports-usage.tsx now, from the database.
 */
export function GeneratedPlaceholder() {
  return (
    <section className="card p-8 text-center">
      <p className="text-sm font-medium">No reports have been generated yet</p>
      <p className="mt-1 text-sm text-[var(--muted)]">
        Every run of a report will be listed here with its period, status, cost and deliveries.
        Running a report is the next phase; a report activated now is scheduled, and nothing fires
        until runs are switched on.
      </p>
    </section>
  );
}
