import { notFound } from "next/navigation";
import { hasModuleAdmin, requireModuleAccess } from "@/lib/authz";
import { BAS_MODULE_KEY } from "@/lib/modules/bas/constants";
import { BasShell } from "../bas-shell";
import { CollectionHealth } from "../collection-health";
import { basTab } from "../tabs";

export const dynamic = "force-dynamic";

/**
 * Collection Health, at /bas/health.
 *
 * It was the module root until the Projects tab took that route (2026-09-30);
 * nothing about the screen changed, only where it lives. The Home card and
 * the "new data gaps" line on Home link here directly, because their words
 * are Collection Health's.
 *
 * It repeats the grant check rather than inheriting one from the tab bar, for
 * the same reason every other tab does: reaching the URL directly is the case
 * that matters, and the tab bar is not involved in it. No layout wraps this,
 * and none may - see settings/page.tsx.
 */
export default async function BasHealthPage() {
  const access = await requireModuleAccess(BAS_MODULE_KEY);
  if (!access.ok) notFound();

  const canAdminister = await hasModuleAdmin(access.viewer.id, BAS_MODULE_KEY);

  return (
    <BasShell blurb={basTab("/bas/health").blurb} canAdminister={canAdminister}>
      <CollectionHealth />
    </BasShell>
  );
}
