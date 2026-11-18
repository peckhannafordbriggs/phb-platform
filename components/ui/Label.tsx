/** A section eyebrow: the platform's `.eyebrow`, muted, with room below it. */
export function Label({ children }: { children: React.ReactNode }) {
  return <p className="eyebrow mb-3 text-[var(--muted)]">{children}</p>;
}
