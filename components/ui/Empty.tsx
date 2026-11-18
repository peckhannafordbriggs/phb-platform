/**
 * The platform's empty state: calm, says there is nothing to do yet, the
 * diamond at low opacity. Promoted from Freeze Protection.
 */
export function Empty({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={"flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center text-[0.8125rem] text-[var(--muted)] " + className}>
      <span className="diamond opacity-30" aria-hidden="true" />
      {children}
    </div>
  );
}
