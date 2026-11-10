"use client";

import type { funnel } from "@/lib/modules/freeze-protection/disposition";
import type { FpTone } from "@/lib/modules/freeze-protection/types";
import { Callout as KitCallout, Pill as KitPill, type Tone } from "@/components/ui";

/**
 * The module's small presentational pieces, at the path the views import them
 * from. Since 2026-11-10 they are the shared kit's (components/ui), re-exported
 * here; the two with a module vocabulary - Pill and Callout, which take an
 * `FpTone` - map that vocabulary onto the kit's and render exactly what they
 * rendered before. `Funnel` is this module's own and stays.
 *
 * Colour rule: the module's orange is identity and appears only in the chrome.
 * Everything here that carries state uses the semantic tones (teal ok, orange
 * warn, maroon bad) and always pairs them with words, because orange is both
 * this module's identity and the platform's warning.
 */

export { Button, Card, Empty, Label, LinkPending } from "@/components/ui";

/** The module's five tones on the kit's five: `open` is the kit's purple, `closed` its neutral. */
const TONE: Record<FpTone, Tone> = {
  ok: "ok",
  warn: "warn",
  bad: "bad",
  open: "draft",
  closed: "muted",
};

/** A line's state, always in words. */
export function Pill({ tone, children }: { tone: FpTone; children: React.ReactNode }) {
  return <KitPill tone={TONE[tone]}>{children}</KitPill>;
}

/** A procedure note: "Closed.", "Stop.", "Deficiency." The lead word carries the state; the tint repeats it. */
export function Callout({ tone, lead, children }: { tone: FpTone; lead: string; children: React.ReactNode }) {
  return (
    <KitCallout tone={TONE[tone]} lead={lead}>
      {children}
    </KitCallout>
  );
}

/**
 * The register narrowing to verified. Each stage is a subset of the one before,
 * so every bar is drawn against the first. Neutral bars; only Verified takes the
 * ok tone, as the one stage that is a state rather than a count.
 */
export function Funnel({ stages }: { stages: readonly ReturnType<typeof funnel>[number][] }) {
  const total = Math.max(stages[0]?.count ?? 0, 1);
  return (
    <ol className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-5" aria-label="Equipment funnel">
      {stages.map((s) => {
        const verified = s.key === "verified";
        return (
          <li key={s.key} className="min-w-0">
            <div className="flex items-baseline justify-between gap-2">
              <span className="eyebrow truncate text-[var(--muted)]">{s.label}</span>
              <span className="font-mono text-[0.9375rem] font-medium" style={{ color: verified ? "var(--phb-teal-ink)" : "var(--foreground)" }}>
                {s.count}
              </span>
            </div>
            <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-[var(--neutral-100)]">
              <div
                className="h-full rounded-full"
                style={{ width: `${(s.count / total) * 100}%`, background: verified ? "var(--phb-teal)" : "var(--neutral-400)" }}
              />
            </div>
          </li>
        );
      })}
    </ol>
  );
}
