import Link from "next/link";
import { LinkPending } from "./LinkPending";

/**
 * The platform's button, promoted from Cost Intelligence (2026-11-10).
 *
 * `primary` is the platform's button red - `--phb-red-btn`, the one shade of
 * the logo red that carries white text at AA (app/globals.css). `secondary` is
 * the white outlined button. `danger` is the quiet destructive one: the same
 * outline with the danger ink, for an action that opens a confirmation.
 *
 * `md` is the 36px button every module uses; `sm` is for a control that sits
 * inside a pane header or an action row, where 36px would set the row's height.
 *
 * No colour is decided here beyond those three: everything else reads the
 * platform tokens, so a module keeps its own palette through `--module-accent`
 * and the semantic aliases rather than through a prop.
 */

type Variant = "primary" | "secondary" | "danger";
type Size = "md" | "sm";

const BASE =
  "inline-flex shrink-0 items-center justify-center gap-1.5 rounded-[var(--radius-control)] font-medium transition-opacity disabled:pointer-events-none disabled:opacity-50";

const SIZES: Record<Size, string> = {
  md: "h-9 px-4 text-[0.8125rem]",
  sm: "h-7 px-2.5 text-xs",
};

const VARIANTS: Record<Variant, string> = {
  primary: "bg-[var(--phb-red-btn)] text-white hover:opacity-90",
  secondary: "border border-[var(--border)] bg-white text-[var(--foreground)] hover:bg-[var(--neutral-50)]",
  danger: "border border-[var(--border)] bg-white text-[var(--danger)] hover:bg-[var(--neutral-100)]",
};

export function Button({
  children,
  variant = "secondary",
  size = "md",
  onClick,
  href,
  type = "button",
  disabled = false,
  fullWidth = false,
  title,
  className = "",
}: {
  children: React.ReactNode;
  variant?: Variant;
  size?: Size;
  onClick?: () => void;
  href?: string;
  type?: "button" | "submit";
  disabled?: boolean;
  fullWidth?: boolean;
  /** The native tooltip, for an action whose label is a verb and whose effect needs a sentence. */
  title?: string;
  className?: string;
}) {
  const classes = `${BASE} ${SIZES[size]} ${VARIANTS[variant]} ${fullWidth ? "w-full" : ""} ${className}`;

  if (href && !disabled) {
    return (
      <Link href={href} className={classes} title={title}>
        {children}
        <LinkPending />
      </Link>
    );
  }

  return (
    <button type={type} onClick={onClick} disabled={disabled} title={title} className={classes}>
      {children}
    </button>
  );
}
