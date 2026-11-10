import type { Tone } from "./Pill";

const CALLOUT: Record<Tone, { bar: string; ground: string }> = {
  ok: { bar: "var(--phb-teal)", ground: "color-mix(in srgb, var(--phb-teal) 12%, transparent)" },
  warn: { bar: "var(--phb-orange)", ground: "color-mix(in srgb, var(--phb-orange) 12%, transparent)" },
  bad: { bar: "var(--phb-maroon)", ground: "color-mix(in srgb, var(--phb-maroon) 8%, transparent)" },
  draft: { bar: "var(--phb-purple)", ground: "color-mix(in srgb, var(--phb-purple) 7%, transparent)" },
  muted: { bar: "var(--neutral-300)", ground: "var(--neutral-50)" },
};

/**
 * A short note with a state: "Closed.", "Stop.", "Not imported." The lead word
 * carries the state; the tint repeats it. Promoted from Freeze Protection.
 */
export function Callout({ tone, lead, children }: { tone: Tone; lead: string; children: React.ReactNode }) {
  const t = CALLOUT[tone];
  return (
    <p
      className="rounded-r-[var(--radius-control)] border-l-[3px] px-3 py-2 text-[0.8125rem] text-[var(--foreground)]"
      style={{ borderColor: t.bar, background: t.ground }}
    >
      <strong className="font-semibold">{lead}</strong> {children}
    </p>
  );
}
