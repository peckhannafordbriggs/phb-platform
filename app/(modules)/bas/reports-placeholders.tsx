/**
 * The two sub-tabs that have nothing to show in Phase 1, saying so honestly.
 *
 * Not a "coming soon" card: each states what it will hold and why it is
 * empty, so a person who lands here knows whether to wait or to report a
 * fault. Pure, so a node test can assert the wording.
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

export function UsagePlaceholder() {
  return (
    <section className="card p-8 text-center">
      <p className="text-sm font-medium">No usage to show</p>
      <p className="mt-1 text-sm text-[var(--muted)]">
        Spend, tokens and time per run, by report and by building, appear here once reports run.
        There have been no runs.
      </p>
    </section>
  );
}
