/**
 * A small label that names a THING rather than a state: a module on an
 * employee's row, a tag on a record (2026-11-13). Not a Pill - a Pill's tone
 * is a state, and a thing has none - so it is neutral: white, the border, the
 * foreground ink.
 *
 * `mark` draws the platform's diamond in a colour the caller names, the way
 * `TabBar`'s `accent` works: an identity colour comes from the caller
 * (lib/module-accent.ts for a module) and never from the kit. `title` is the
 * long form of a short label - "Building Automation" behind "BAS" - shown as
 * the tooltip and read as the accessible name in place of the abbreviation.
 */
export function Chip({ mark, title, children }: { mark?: string; title?: string; children: React.ReactNode }) {
  return (
    <span
      title={title}
      className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-[var(--border)] bg-white px-2 py-0.5 text-[0.6875rem] font-medium text-[var(--foreground)]"
    >
      {mark !== undefined && (
        <span className="diamond diamond--filled h-[0.4375rem] w-[0.4375rem]" style={{ color: mark }} aria-hidden="true" />
      )}
      {title !== undefined ? (
        <>
          <span aria-hidden="true">{children}</span>
          <span className="sr-only">{title}</span>
        </>
      ) : (
        children
      )}
    </span>
  );
}
