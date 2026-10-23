import type { FpHistoryEntry } from "@/lib/modules/freeze-protection/types";

const AT = new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: "America/New_York" });

/**
 * A unit's history, newest first: every audited change with who and when.
 * Shared by the step pane and the single-unit report. Times are New York time.
 */
export function History({ entries }: { entries: FpHistoryEntry[] }) {
  if (entries.length === 0) return <p className="text-[0.8125rem] text-[var(--muted)]">No changes recorded yet.</p>;
  return (
    <ol className="flex flex-col">
      {entries.map((h) => (
        <li key={h.id} className="grid grid-cols-[9.5rem_minmax(0,1fr)] gap-3 border-b border-[var(--divider-soft)] py-1.5 text-[0.75rem] last:border-b-0">
          <time dateTime={h.at} className="font-mono text-[var(--muted)]">
            {AT.format(new Date(h.at))}
          </time>
          <span>{h.sentence}</span>
        </li>
      ))}
    </ol>
  );
}
