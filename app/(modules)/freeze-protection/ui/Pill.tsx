import type { FpTone } from "@/lib/modules/freeze-protection/types";

/**
 * A register line's state. Semantic colour only (teal ok, orange warn, maroon bad);
 * the module's own orange never appears here. Because orange is ALSO this module's
 * identity, a pill always carries words: the colour is never the message.
 */
const TONES: Record<FpTone, string> = {
  ok: "bg-[color-mix(in_srgb,var(--phb-teal)_22%,transparent)] text-[var(--phb-teal-ink)]",
  warn: "bg-[color-mix(in_srgb,var(--phb-orange)_20%,transparent)] text-[var(--phb-orange-ink)]",
  bad: "bg-[color-mix(in_srgb,var(--phb-maroon)_12%,transparent)] text-[var(--phb-maroon)]",
  open: "bg-[color-mix(in_srgb,var(--phb-purple)_12%,transparent)] text-[var(--phb-purple)]",
  closed: "bg-[var(--neutral-100)] text-[var(--muted)]",
};

export function Pill({ tone, children }: { tone: FpTone; children: React.ReactNode }) {
  return (
    <span className={"inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-[0.6875rem] font-medium " + TONES[tone]}>
      {children}
    </span>
  );
}
