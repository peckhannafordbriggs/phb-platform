export type PillTone = "ok" | "draft" | "muted" | "warn";

const TONES: Record<PillTone, string> = {
  ok: "bg-[color-mix(in_srgb,var(--phb-teal)_22%,transparent)] text-[var(--phb-teal-ink)]",
  draft: "bg-[color-mix(in_srgb,var(--phb-purple)_12%,transparent)] text-[var(--phb-purple)]",
  muted: "bg-[var(--neutral-100)] text-[var(--muted)]",
  warn: "bg-[color-mix(in_srgb,var(--phb-orange)_20%,transparent)] text-[var(--phb-orange-ink)]",
};

/** A small status label. The tone is a state (ok, draft, warning), never decoration. */
export function Pill({ tone, children }: { tone: PillTone; children: React.ReactNode }) {
  return (
    <span className={"inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-[0.6875rem] font-medium " + TONES[tone]}>
      {children}
    </span>
  );
}
