"use client";

import { SearchBar as KitSearchBar, type SearchResult } from "@/components/ui/SearchBar";
import { PLACEHOLDER_SKILLS } from "@/lib/modules/cost-intelligence/placeholder-settings";

/**
 * TODO(backend): replace with `GET /api/modules/cost-intelligence/search?q=` over real runs and
 * cip_skills. Run results were placeholders and are left out until then. Skills are admin only.
 */
function search(query: string, canAdminister: boolean): SearchResult[] {
  const all: SearchResult[] = [
    ...(canAdminister
      ? PLACEHOLDER_SKILLS.map((s) => ({ href: `/cost-intelligence/settings/skills/${s.id}`, kind: "Skill", label: s.name, detail: s.id }))
      : []),
  ];
  const q = query.toLowerCase();
  return all.filter((r) => `${r.label} ${r.detail}`.toLowerCase().includes(q)).slice(0, 8);
}

/**
 * Live search over runs and (for admins) skills. "/" anywhere focuses it.
 * The box itself is the shared kit's (2026-11-10); this file supplies what it searches.
 */
export function SearchBar({
  placeholder = "Search runs and skills",
  canAdminister = false,
}: {
  placeholder?: string;
  canAdminister?: boolean;
}) {
  return <KitSearchBar label="Search Cost Intelligence" placeholder={placeholder} search={(q) => search(q, canAdminister)} />;
}
