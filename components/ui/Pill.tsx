/**
 * The five tones a state can take. A tone is a state, never decoration: the
 * platform's semantic colours (teal ok, orange warning, maroon bad) are kept
 * apart from its decorative ones, and every tone is paired with words.
 *
 *   ok     teal      done, verified, succeeded
 *   warn   orange    needs attention, failed, waiting
 *   bad    maroon    the failure itself, a stop
 *   draft  purple    in progress, open, not yet final
 *   muted  neutral   closed, cancelled, inactive
 */
export type Tone = "ok" | "warn" | "bad" | "draft" | "muted";

/** The name Cost Intelligence used before the kit was shared; the same type. */
export type PillTone = Tone;

const TONES: Record<Tone, string> = {
  ok: "bg-[color-mix(in_srgb,var(--phb-teal)_22%,transparent)] text-[var(--phb-teal-ink)]",
  draft: "bg-[color-mix(in_srgb,var(--phb-purple)_12%,transparent)] text-[var(--phb-purple)]",
  muted: "bg-[var(--neutral-100)] text-[var(--muted)]",
  warn: "bg-[color-mix(in_srgb,var(--phb-orange)_20%,transparent)] text-[var(--phb-orange-ink)]",
  bad: "bg-[color-mix(in_srgb,var(--phb-maroon)_12%,transparent)] text-[var(--phb-maroon)]",
};

/** A small status label. The tone is a state (ok, draft, warning), never decoration. */
export function Pill({ tone, children }: { tone: Tone; children: React.ReactNode }) {
  return (
    <span className={"inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-[0.6875rem] font-medium " + TONES[tone]}>
      {children}
    </span>
  );
}
