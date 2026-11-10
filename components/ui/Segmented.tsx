const TONES = {
  dark: { track: "border border-[var(--border)] bg-white", on: "bg-[var(--neutral-900)] font-medium text-white" },
  light: { track: "bg-[var(--neutral-100)]", on: "bg-white font-medium text-[var(--foreground)] shadow-sm" },
};

/**
 * A row of mutually exclusive buttons, e.g. a date range (`dark`) or
 * live-vs-pinned (`light`). `fullWidth` stretches the strip and shares it
 * equally between the options, for a control that spans a pane.
 */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  label,
  tone = "dark",
  fullWidth = false,
}: {
  options: { value: T; label: React.ReactNode }[];
  value: T;
  onChange: (value: T) => void;
  label: string;
  tone?: keyof typeof TONES;
  fullWidth?: boolean;
}) {
  const t = TONES[tone];
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className={(fullWidth ? "flex w-full" : "inline-flex") + " rounded-[var(--radius-control)] p-0.5 " + t.track}
    >
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
              (fullWidth ? "flex-1 " : "") +
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
