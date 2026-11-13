"use client";

/**
 * An on / off control with its words beside it (2026-11-13, the Admin
 * Employees list's expanded row). `role="switch"` with `aria-checked`, so it
 * announces as a switch and the words are its accessible name; the whole
 * thing is one button, so the words are a click target too.
 *
 * On, the track takes the module's accent - the platform purple outside a
 * module - and off it is a neutral; the knob's position says the same thing,
 * and the caller's words say what is on. No colour is decided here beyond
 * those tokens. `description` is a second, quieter line under the label, for
 * the caller's caveat.
 */
export function Switch({
  label,
  checked,
  onChange,
  disabled = false,
  description,
}: {
  label: React.ReactNode;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  description?: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className="inline-flex items-start gap-2.5 text-left text-[0.8125rem] text-[var(--foreground)] disabled:cursor-default disabled:opacity-50"
    >
      <span
        aria-hidden="true"
        className={
          "relative mt-px inline-block h-5 w-9 shrink-0 rounded-full transition-colors " +
          (checked ? "bg-[var(--module-accent)]" : "bg-[var(--neutral-300)]")
        }
      >
        <span
          className={
            "absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-white shadow-[var(--shadow-row)] transition-transform " +
            (checked ? "translate-x-4" : "")
          }
        />
      </span>
      <span className="min-w-0">
        <span className="block leading-5">{label}</span>
        {description !== undefined && <span className="block text-[0.75rem] text-[var(--muted)]">{description}</span>}
      </span>
    </button>
  );
}
