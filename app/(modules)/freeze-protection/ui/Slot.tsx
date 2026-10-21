/**
 * PHASE 1 PLACEHOLDER. Marks a region whose layout is fixed but whose detail is
 * designed in phase 2. Every use is deleted when its region is built; this file
 * goes with the last one.
 */
export function Slot({
  label,
  note,
  className = "",
}: {
  label: string;
  /** What goes here, in one line. */
  note?: string;
  className?: string;
}) {
  return (
    <div
      className={
        "flex min-h-24 flex-col justify-center gap-1 rounded-[var(--radius-row)] border border-dashed border-[var(--neutral-300)] px-4 py-3 " +
        className
      }
    >
      <p className="eyebrow text-[var(--muted)]">{label}</p>
      {note && <p className="text-[0.8125rem] text-[var(--muted)]">{note}</p>}
    </div>
  );
}
