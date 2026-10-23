"use client";

import { Loader2 } from "lucide-react";
import Link, { useLinkStatus } from "next/link";
import type { funnel } from "@/lib/modules/freeze-protection/disposition";
import type { FpTone } from "@/lib/modules/freeze-protection/types";

/**
 * The module's small presentational pieces, in one file: no behaviour, the
 * views own the handlers. Form controls are in ./Field.tsx.
 *
 * Colour rule: the module's orange is identity and appears only in the chrome.
 * Everything here that carries state uses the semantic tones (teal ok, orange
 * warn, maroon bad) and always pairs them with words, because orange is both
 * this module's identity and the platform's warning.
 */

// ---------------------------------------------------------------------------
// Surfaces and text
// ---------------------------------------------------------------------------

/** The platform's `.card` surface. Padding is a prop, not a class, so it can't lose to the default. */
export function Card({ className = "", padding = "p-5", children }: { className?: string; padding?: string; children: React.ReactNode }) {
  return <div className={`card ${padding} ${className}`}>{children}</div>;
}

/** A section eyebrow. */
export function Label({ children }: { children: React.ReactNode }) {
  return <p className="eyebrow mb-3 text-[var(--muted)]">{children}</p>;
}

/** The platform's empty state: calm, says there is nothing to do yet, the diamond at low opacity. */
export function Empty({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={"flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center text-[0.8125rem] text-[var(--muted)] " + className}>
      <span className="diamond opacity-30" aria-hidden="true" />
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Buttons and links
// ---------------------------------------------------------------------------

/** Inside a <Link>: a small spinner while that link's page loads. */
export function LinkPending({ children }: { children?: React.ReactNode }) {
  const { pending } = useLinkStatus();
  if (!pending) return <>{children}</>;
  return <Loader2 size={12} role="status" aria-label="Loading" className="shrink-0 animate-spin opacity-60" />;
}

const BUTTON =
  "inline-flex h-9 shrink-0 items-center justify-center gap-1.5 rounded-[var(--radius-control)] px-4 text-[0.8125rem] font-medium transition-opacity disabled:pointer-events-none disabled:opacity-50";
const BUTTON_VARIANT = {
  primary: "bg-[var(--phb-red-btn)] text-white hover:opacity-90",
  secondary: "border border-[var(--border)] bg-white text-[var(--foreground)] hover:bg-[var(--neutral-50)]",
};

/** The CIP button: 36px, primary in the platform's button red, secondary white. `href` renders a link. */
export function Button({
  children,
  variant = "secondary",
  onClick,
  href,
  type = "button",
  disabled = false,
  className = "",
}: {
  children: React.ReactNode;
  variant?: keyof typeof BUTTON_VARIANT;
  onClick?: () => void;
  href?: string;
  type?: "button" | "submit";
  disabled?: boolean;
  className?: string;
}) {
  const classes = `${BUTTON} ${BUTTON_VARIANT[variant]} ${className}`;
  if (href && !disabled) {
    return (
      <Link href={href} className={classes}>
        {children}
        <LinkPending />
      </Link>
    );
  }
  return (
    <button type={type} onClick={onClick} disabled={disabled} className={classes}>
      {children}
    </button>
  );
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const PILL: Record<FpTone, string> = {
  ok: "bg-[color-mix(in_srgb,var(--phb-teal)_22%,transparent)] text-[var(--phb-teal-ink)]",
  warn: "bg-[color-mix(in_srgb,var(--phb-orange)_20%,transparent)] text-[var(--phb-orange-ink)]",
  bad: "bg-[color-mix(in_srgb,var(--phb-maroon)_12%,transparent)] text-[var(--phb-maroon)]",
  open: "bg-[color-mix(in_srgb,var(--phb-purple)_12%,transparent)] text-[var(--phb-purple)]",
  closed: "bg-[var(--neutral-100)] text-[var(--muted)]",
};

/** A line's state, always in words. */
export function Pill({ tone, children }: { tone: FpTone; children: React.ReactNode }) {
  return (
    <span className={"inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-[0.6875rem] font-medium " + PILL[tone]}>{children}</span>
  );
}

const CALLOUT: Record<FpTone, { bar: string; ground: string }> = {
  ok: { bar: "var(--phb-teal)", ground: "color-mix(in srgb, var(--phb-teal) 12%, transparent)" },
  warn: { bar: "var(--phb-orange)", ground: "color-mix(in srgb, var(--phb-orange) 12%, transparent)" },
  bad: { bar: "var(--phb-maroon)", ground: "color-mix(in srgb, var(--phb-maroon) 8%, transparent)" },
  open: { bar: "var(--phb-purple)", ground: "color-mix(in srgb, var(--phb-purple) 7%, transparent)" },
  closed: { bar: "var(--neutral-300)", ground: "var(--neutral-50)" },
};

/** A procedure note: "Closed.", "Stop.", "Deficiency." The lead word carries the state; the tint repeats it. */
export function Callout({ tone, lead, children }: { tone: FpTone; lead: string; children: React.ReactNode }) {
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

/**
 * The register narrowing to verified. Each stage is a subset of the one before,
 * so every bar is drawn against the first. Neutral bars; only Verified takes the
 * ok tone, as the one stage that is a state rather than a count.
 */
export function Funnel({ stages }: { stages: readonly ReturnType<typeof funnel>[number][] }) {
  const total = Math.max(stages[0]?.count ?? 0, 1);
  return (
    <ol className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-5" aria-label="Register funnel">
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
