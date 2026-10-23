"use client";

import { useState } from "react";

/**
 * Form fields for the step pane and the add forms. Presentational: each takes a
 * value and an `onSave`, and the view decides what saving means. Text saves on
 * blur or Enter, choices save on change: every change saves immediately and the
 * page re-renders from the database, so there is never unsaved state to lose.
 */

export const INPUT =
  "h-9 w-full rounded-[var(--radius-control)] border border-[var(--border)] bg-white px-3 text-[0.8125rem] text-[var(--foreground)] focus:border-[var(--module-accent)] focus:outline-none disabled:opacity-60";

export function FieldLabel({ label, children, wide = false }: { label: string; children: React.ReactNode; wide?: boolean }) {
  return (
    <label className={"flex min-w-0 flex-col gap-1 " + (wide ? "col-span-full" : "")}>
      <span className="text-[0.75rem] text-[var(--muted)]">{label}</span>
      {children}
    </label>
  );
}

type SaveText = (value: string | null) => void;

/** Free text. `null` when cleared. Mono for tags, readings and other data. */
export function TextField({
  label,
  value,
  onSave,
  mono = false,
  placeholder,
  wide = false,
}: {
  label: string;
  value: string | null;
  onSave: SaveText;
  mono?: boolean;
  placeholder?: string;
  wide?: boolean;
}) {
  const [draft, setDraft] = useState(value ?? "");
  const commit = () => {
    const next = draft.trim() === "" ? null : draft;
    if ((next ?? "") !== (value ?? "")) onSave(next);
  };
  return (
    <FieldLabel label={label} wide={wide}>
      <input
        type="text"
        value={draft}
        placeholder={placeholder}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
        className={INPUT + (mono ? " font-mono" : "")}
      />
    </FieldLabel>
  );
}

export function TextArea({ label, value, onSave }: { label: string; value: string | null; onSave: SaveText }) {
  const [draft, setDraft] = useState(value ?? "");
  return (
    <FieldLabel label={label} wide>
      <textarea
        value={draft}
        rows={3}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          const next = draft.trim() === "" ? null : draft;
          if ((next ?? "") !== (value ?? "")) onSave(next);
        }}
        className={INPUT + " h-auto resize-y py-2"}
      />
    </FieldLabel>
  );
}

/** A date-only value, `YYYY-MM-DD`. Saves when a whole date is picked or cleared. */
export function DateField({ label, value, onSave }: { label: string; value: string | null; onSave: SaveText }) {
  return (
    <FieldLabel label={label}>
      <input
        type="date"
        defaultValue={value ?? ""}
        onChange={(e) => {
          const v = e.target.value;
          if (v === "" || /^\d{4}-\d{2}-\d{2}$/.test(v)) {
            const next = v === "" ? null : v;
            if (next !== value) onSave(next);
          }
        }}
        className={INPUT + " font-mono"}
      />
    </FieldLabel>
  );
}

/** A number, saved on blur. Empty clears it. */
export function NumberField({
  label,
  value,
  onSave,
}: {
  label: string;
  value: string | null;
  onSave: (value: number | null) => void;
}) {
  const [draft, setDraft] = useState(value ?? "");
  return (
    <FieldLabel label={label}>
      <input
        type="number"
        inputMode="decimal"
        step="0.5"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          if (draft === (value ?? "")) return;
          if (draft.trim() === "") return onSave(null);
          const n = Number(draft);
          if (Number.isFinite(n)) onSave(n);
        }}
        onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
        className={INPUT + " font-mono"}
      />
    </FieldLabel>
  );
}

/** A closed vocabulary. The first option is "Not answered" unless `required`. */
export function SelectField<T extends string>({
  label,
  value,
  options,
  onSave,
  required = false,
  wide = false,
}: {
  label: string;
  value: T | null;
  options: { value: T; label: string }[];
  onSave: (value: T | null) => void;
  required?: boolean;
  wide?: boolean;
}) {
  return (
    <FieldLabel label={label} wide={wide}>
      <select
        value={value ?? ""}
        onChange={(e) => onSave(e.target.value === "" ? null : (e.target.value as T))}
        className={INPUT}
      >
        {!required && <option value="">Not answered</option>}
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </FieldLabel>
  );
}

/**
 * One safety test. Yes and No carry their words and a tone; clicking the chosen
 * answer again clears it. A No is the failure, so it reads maroon, never red.
 */
export function YesNo({
  label,
  value,
  onSave,
}: {
  label: string;
  value: "yes" | "no" | undefined;
  onSave: (value: "yes" | "no" | null) => void;
}) {
  const button = (v: "yes" | "no") => {
    const on = value === v;
    const tone =
      v === "yes"
        ? "bg-[color-mix(in_srgb,var(--phb-teal)_22%,transparent)] text-[var(--phb-teal-ink)] font-medium"
        : "bg-[color-mix(in_srgb,var(--phb-maroon)_12%,transparent)] text-[var(--phb-maroon)] font-medium";
    return (
      <button
        type="button"
        role="radio"
        aria-checked={on}
        onClick={() => onSave(on ? null : v)}
        className={
          "rounded-[calc(var(--radius-control)-2px)] px-3 py-1 text-[0.8125rem] transition-colors " +
          (on ? tone : "text-[var(--muted)] hover:text-[var(--foreground)]")
        }
      >
        {v === "yes" ? "Yes" : "No"}
      </button>
    );
  };
  return (
    <div className="flex items-center justify-between gap-3 border-b border-[var(--divider-soft)] py-2 last:border-b-0">
      <span className="text-[0.8125rem]">{label}</span>
      <div role="radiogroup" aria-label={label} className="inline-flex shrink-0 rounded-[var(--radius-control)] border border-[var(--border)] bg-white p-0.5">
        {button("yes")}
        {button("no")}
      </div>
    </div>
  );
}
