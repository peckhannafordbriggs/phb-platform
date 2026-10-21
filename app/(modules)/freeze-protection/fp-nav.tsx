"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { LinkPending } from "./ui/LinkPending";

/** Plain data: it crosses from the server shell into this client component. */
export type Tab = { href: string; label: string; path: string; exact?: boolean };

/** Underlined tab bar, the BAS and CIP pattern. Active tab = bottom border in the module accent. */
export function FpNav({ tabs, actions }: { tabs: Tab[]; actions?: React.ReactNode }) {
  const pathname = usePathname();

  return (
    <nav aria-label="Freeze Protection sections" className="mt-3 flex flex-wrap items-center justify-between gap-3">
      <ul className="-mb-px flex gap-1 border-b border-[var(--border)]">
        {tabs.map((t) => {
          const active = t.exact ? pathname === t.path : pathname.startsWith(t.path);
          return (
            <li key={t.label}>
              <Link
                href={t.href}
                aria-current={active ? "page" : undefined}
                className={
                  "inline-flex items-center gap-1.5 border-b-2 px-3 py-2 text-[0.8125rem] transition-colors " +
                  (active
                    ? "font-medium text-[var(--foreground)]"
                    : "border-transparent text-[var(--muted)] hover:text-[var(--foreground)]")
                }
                style={active ? { borderColor: "var(--module-accent)" } : undefined}
              >
                {t.label}
                <LinkPending />
              </Link>
            </li>
          );
        })}
      </ul>
      {actions !== undefined && <div className="flex items-center gap-2">{actions}</div>}
    </nav>
  );
}
