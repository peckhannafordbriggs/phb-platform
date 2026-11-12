"use client";

import { usePathname, useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { TabBar } from "@/components/ui";
import { tabHref } from "../tabs";

/**
 * The Settings tab's own row (2026-11-12), the Cost Intelligence shape:
 * General (what this platform collects from - the screen Settings always
 * was) and Usage (the Reports Usage view, safety ceiling included, drawn
 * by the same component at a second route). The kit's TabBar, under the
 * module bar, which keeps Settings active for every path under it.
 *
 * Which item is active is decided here by exact match on the item's path,
 * because the two items are siblings and neither is a prefix of the other's
 * content. The query string is carried across, as the module tabs carry it,
 * so a search or filter on General survives a look at Usage and back.
 */
export interface BasSettingsNavItem {
  href: string;
  label: string;
}

export const BAS_SETTINGS_NAV: readonly BasSettingsNavItem[] = [
  { href: "/bas/settings", label: "General" },
  { href: "/bas/settings/usage", label: "Usage" },
];

/** Which item a path belongs to: `/bas/settings/usage` and below is Usage; everything else under Settings is General. */
export function activeSettingsItemHref(pathname: string): string {
  const usage = BAS_SETTINGS_NAV[1]!.href;
  return pathname === usage || pathname.startsWith(`${usage}/`) ? usage : BAS_SETTINGS_NAV[0]!.href;
}

export function BasSettingsNav() {
  const pathname = usePathname() ?? "";
  return (
    <div className="-mt-3 mb-6">
      <Suspense fallback={<Row pathname={pathname} hrefFor={(href) => href} />}>
        <LiveRow pathname={pathname} />
      </Suspense>
    </div>
  );
}

function LiveRow({ pathname }: { pathname: string }) {
  const searchParams = useSearchParams();
  return <Row pathname={pathname} hrefFor={(href) => tabHref(href, searchParams)} />;
}

function Row({ pathname, hrefFor }: { pathname: string; hrefFor: (href: string) => string }) {
  const active = activeSettingsItemHref(pathname);
  return (
    <TabBar
      label="Building Automation settings"
      tabs={BAS_SETTINGS_NAV.map((item) => ({ href: hrefFor(item.href), label: item.label, active: item.href === active }))}
    />
  );
}
