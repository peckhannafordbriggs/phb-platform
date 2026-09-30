"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

export type Tab = { href: string; label: string; prefixes?: string[] };

/**
 * Underlined tab bar, the BAS pattern. `actions` is whatever the caller puts on the
 * right; the nav itself only knows about tabs.
 */
export function CipNav({
  tabs,
  label,
  actions,
}: {
  tabs: Tab[];
  label: string;
  actions?: React.ReactNode;
}) {
  const pathname = usePathname();

  return (
    <nav aria-label={label} className="mt-3  flex items-center justify-between">
      <ul className="-mb-px flex gap-1 border-b border-[var(--border)]">
        {tabs.map((t) => {
          const active = pathname === t.href || (t.prefixes ?? []).some((p) => pathname.startsWith(p));
          return (
            <li key={t.href}>
              <Link
                href={t.href}
                aria-current={active ? "page" : undefined}
                className={
                  "inline-block border-b-2 px-3 py-2 text-[0.8125rem] transition-colors " +
                  (active
                    ? "font-medium text-[var(--foreground)]"
                    : "border-transparent text-[var(--muted)] hover:text-[var(--foreground)]")
                }
                style={active ? { borderColor: "var(--module-accent)" } : undefined}
              >
                {t.label}
              </Link>
            </li>
          );
        })}
      </ul>
      {actions !== undefined && <div className="flex items-center gap-2">{actions}</div>}
    </nav>
  );
}
