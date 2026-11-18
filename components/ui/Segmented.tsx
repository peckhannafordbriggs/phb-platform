const TONES = {
  dark: { track: "border border-[var(--border)] bg-white", on: "bg-[var(--neutral-900)] font-medium text-white" },
  light: { track: "bg-[var(--neutral-100)]", on: "bg-white font-medium text-[var(--foreground)] shadow-sm" },
  /** The platform accent on the chosen option: a time range on the BAS screens. */
  accent: { track: "border border-[var(--border)] bg-white", on: "bg-[var(--accent)] font-medium text-white" },
};

/**
 * A row of mutually exclusive buttons, e.g. a date range (`dark`) or
 * live-vs-pinned (`light`). `fullWidth` stretches the strip and shares it
 * equally between the options, for a control that spans a pane.
 *
 * `semantics` is how the strip announces itself. The default is a radio
 * group, which is what "exactly one of these" is. `pressed` is a group of
 * toggle buttons, one pressed at a time - the older form the BAS screens were
 * built and tested with (`role="group"`, `aria-pressed`), kept so a screen
 * can move onto the kit without changing what assistive technology hears.
 */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  label,
  tone = "dark",
  fullWidth = false,
  semantics = "radio",
}: {
  options: { value: T; label: React.ReactNode }[];
  value: T;
  onChange: (value: T) => void;
  label: string;
  tone?: keyof typeof TONES;
  fullWidth?: boolean;
  semantics?: "radio" | "pressed";
}) {
  const t = TONES[tone];
  const radio = semantics === "radio";
  return (
    <div
      role={radio ? "radiogroup" : "group"}
      aria-label={label}
      className={(fullWidth ? "flex w-full" : "inline-flex") + " rounded-[var(--radius-control)] p-0.5 " + t.track}
    >
      {options.map((o) => {
        const on = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role={radio ? "radio" : undefined}
            aria-checked={radio ? on : undefined}
            aria-pressed={radio ? undefined : on}
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
