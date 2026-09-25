import Link from "next/link";

type Variant = "primary" | "secondary";

const BASE =
  "inline-flex h-9 shrink-0 items-center justify-center rounded-[var(--radius-control)] px-4 text-[0.8125rem] font-medium transition-opacity disabled:pointer-events-none disabled:opacity-50";

const VARIANTS: Record<Variant, string> = {
  primary: "bg-[var(--phb-red-btn)] text-white hover:opacity-90",
  secondary: "border border-[var(--border)] bg-white text-[var(--foreground)] hover:bg-[var(--neutral-50)]",
};

export function Button({
  children,
  variant = "secondary",
  onClick,
  href,
  type = "button",
  disabled = false,
  fullWidth = false,
  className = "",
}: {
  children: React.ReactNode;
  variant?: Variant;
  onClick?: () => void;
  href?: string;
  type?: "button" | "submit";
  disabled?: boolean;
  fullWidth?: boolean;
  className?: string;
}) {
  const classes = `${BASE} ${VARIANTS[variant]} ${fullWidth ? "w-full" : ""} ${className}`;

  if (href && !disabled) {
    return (
      <Link href={href} className={classes}>
        {children}
      </Link>
    );
  }

  return (
    <button type={type} onClick={onClick} disabled={disabled} className={classes}>
      {children}
    </button>
  );
}
