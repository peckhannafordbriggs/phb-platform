import Link from "next/link";

/**
 * Ask and History. Two links do not need the tab framework the BAS and
 * Change Orders modules carry; each page checks the grant itself.
 */
export const KB_TABS = [
  { href: "/knowledge-base", label: "Ask" },
  { href: "/knowledge-base/history", label: "History" },
] as const;

export function KbTabs({ current }: { current: (typeof KB_TABS)[number]["href"] }) {
  return (
    <nav aria-label="Knowledge Base" className="mt-4 flex gap-5 border-b border-[var(--border)] text-sm">
      {KB_TABS.map((tab) => (
        <Link
          key={tab.href}
          href={tab.href}
          aria-current={tab.href === current ? "page" : undefined}
          className={`-mb-px border-b-2 pb-2 ${
            tab.href === current
              ? "border-[var(--module-accent)] font-medium"
              : "border-transparent text-[var(--muted)] hover:text-[var(--foreground)]"
          }`}
        >
          {tab.label}
        </Link>
      ))}
    </nav>
  );
}
