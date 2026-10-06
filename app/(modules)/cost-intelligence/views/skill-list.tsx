"use client";

import Link from "next/link";
import { useEffect, useRef } from "react";

export type SkillListItem = { folderName: string; name: string; version: number };

/**
 * The skills list on the catalog page. Each skill is its own URL, so picking one
 * re-renders the page and the list starts at the top again; scrolling the
 * selected row back into view keeps the place. `scroll={false}` stops the page
 * itself jumping to the top.
 */
export function SkillList({ skills, selected }: { skills: SkillListItem[]; selected: string | null }) {
  const selectedRef = useRef<HTMLAnchorElement>(null);

  useEffect(() => {
    selectedRef.current?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  return (
    <ul className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto p-2">
      {skills.map((s) => {
        const isSelected = s.folderName === selected;
        return (
          <li key={s.folderName}>
            <Link
              ref={isSelected ? selectedRef : undefined}
              href={`/cost-intelligence/settings/skills/${encodeURIComponent(s.folderName)}`}
              scroll={false}
              aria-current={isSelected ? "page" : undefined}
              className={
                "flex items-center justify-between gap-3 rounded-[var(--radius-control)] px-3 py-1.5 text-[0.8125rem] transition-colors " +
                (isSelected
                  ? "bg-[color-mix(in_srgb,var(--module-accent)_16%,transparent)] font-semibold text-[var(--module-accent-ink)]"
                  : "text-[var(--foreground)] hover:bg-[var(--neutral-100)]")
              }
            >
              <span className="truncate">{s.name}</span>
              <span className="shrink-0 font-mono text-[0.6875rem] text-[var(--muted)]">v{s.version}</span>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
