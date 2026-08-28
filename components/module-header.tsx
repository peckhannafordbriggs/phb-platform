import { moduleAccent } from "@/lib/module-accent";

/**
 * The header every module screen opens with.
 *
 * Three jobs, and the third is the one that matters:
 *
 *   1. Names the module, in Archivo - signage rather than prose.
 *   2. Carries the module's diamond in the module's own colour, which is the
 *      same shape and the same colour as the active item in the sidebar. Those
 *      two marks agreeing is what makes the colour mean "which system am I in"
 *      rather than "somebody liked red".
 *   3. Publishes `--module-accent` and `--module-accent-ink` to everything
 *      inside it. A control that needs the module's colour - a Send button, a
 *      chart line - reads the variable and never learns which module it is in.
 *
 * The colour comes from lib/module-accent.ts, keyed on the module key. That is a
 * lookup with no authority: a key it does not know still gets a colour, and the
 * worst case is the wrong one.
 */
export function ModuleHeader({
  moduleKey,
  title,
  blurb,
  children,
}: {
  moduleKey: string;
  title: string;
  /** One line. Longer than that belongs on the screen, not in its header. */
  blurb?: string;
  /** Tabs, or anything else that belongs to the header rather than the page. */
  children?: React.ReactNode;
}) {
  const accent = moduleAccent(moduleKey);

  return (
    <header
      className="shrink-0"
      style={
        {
          "--module-accent": accent.fill,
          "--module-accent-ink": accent.ink,
        } as React.CSSProperties
      }
    >
      <div className="flex items-center gap-2.5">
        <span
          className="diamond diamond--filled"
          style={{ color: "var(--module-accent)" }}
          aria-hidden="true"
        />
        <h1 className="font-[family-name:var(--font-display)] text-[1.0625rem] font-semibold uppercase tracking-[0.06em]">
          {title}
        </h1>
      </div>

      {/*
        A hairline in the module's colour, then the page. Two pixels of accent
        rather than a filled bar: the brief's rule is that saturated colour is
        for state and identity and never for filling areas, and a coloured band
        across the top of a dense screen is filling an area.
      */}
      <div
        className="mt-2 h-px w-full"
        style={{ background: "var(--module-accent)" }}
        aria-hidden="true"
      />

      {blurb !== undefined && (
        <p className="mt-3 max-w-3xl text-sm text-[var(--muted)]">{blurb}</p>
      )}

      {children}
    </header>
  );
}
