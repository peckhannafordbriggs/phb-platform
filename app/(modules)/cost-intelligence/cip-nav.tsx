"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { ArrowLeft, Plus } from "lucide-react";
import { SearchBar } from "./ui/searchbar";
import { Button } from "./ui/Button";

export type Tab = { href: string; label: string; prefixes?: string[] };

/** Underlined tab bar, the BAS pattern. */
export function CipNav({ tabs, label }: { tabs: Tab[]; label: string }) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  // On Runs with ?new=1 the launcher is showing, so New run closes it instead.
  const launcherOpen = pathname === "/cost-intelligence" && searchParams.get("new") !== null;

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
      <div className="flex items-center gap-2">
        <SearchBar />
        {pathname.startsWith("/cost-intelligence/runs/") ? (
          <Button variant="primary" href="/cost-intelligence">
            <ArrowLeft size={16} aria-hidden="true" />
            Back
          </Button>
        ) : (
          <Button variant="primary" href={launcherOpen ? "/cost-intelligence" : "/cost-intelligence?new=1"}>
            <Plus size={16} aria-hidden="true" />
            New run
          </Button>
        )}
      </div>
    </nav>
  );
}
