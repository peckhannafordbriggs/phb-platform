export function Button({ w = 104, filled = false }: { w?: number | string; filled?: boolean }) {
  return (
    <div
      aria-hidden="true"
      className={
        "h-9 shrink-0 rounded-[var(--radius-control)] " +
        (filled ? "bg-[var(--module-accent-ink)] opacity-40" : "border border-[var(--border)] bg-white")
      }
      style={{ width: w }}
    />
  );
}