const TONES = {
  dark: { track: "border border-[var(--border)] bg-white", on: "bg-[var(--neutral-900)] font-medium text-white" },
  light: { track: "bg-[var(--neutral-100)]", on: "bg-white font-medium text-[var(--foreground)] shadow-sm" },
};

/** A row of mutually exclusive buttons, e.g. a date range (`dark`) or live-vs-pinned (`light`). */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  label,
  tone = "dark",
}: {
  options: { value: T; label: React.ReactNode }[];
  value: T;
  onChange: (value: T) => void;
  label: string;
  tone?: keyof typeof TONES;
}) {
  const t = TONES[tone];
  return (
    <div role="radiogroup" aria-label={label} className={"inline-flex rounded-[var(--radius-control)] p-0.5 " + t.track}>
      {options.map((o) => {
        const on = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={on}
            onClick={() => onChange(o.value)}
            className={
              "rounded-[calc(var(--radius-control)-2px)] px-3 py-1.5 text-[0.8125rem] transition-colors " +
              (on ? t.on : "text-[var(--muted)] hover:text-[var(--foreground)]")
            }
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
