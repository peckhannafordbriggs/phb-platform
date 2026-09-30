import { notFound } from "next/navigation";
import { hasModuleAdmin, requireModuleAccess } from "@/lib/authz";
import { BAS_MODULE_KEY } from "@/lib/modules/bas/constants";
import { BasShell } from "./bas-shell";
import { Dashboard } from "./dashboard";
import { basTab } from "./tabs";

export const dynamic = "force-dynamic";

/**
 * Dashboard - the tab the module opens on, at /bas (2026-09-30).
 *
 * Collection Health lived here until then and is at /bas/health now; every
 * other tab kept its route.
 *
 * Guarded here, on this route, and not by the tab bar. A tab bar is navigation;
 * every route behind it carries its own guard and so does every API route it
 * calls. Navigating straight to /bas without a grant must not render the module
 * and must not reveal that it exists - hence notFound() rather than a 403.
 */
export default async function BasPage() {
  const access = await requireModuleAccess(BAS_MODULE_KEY);
  if (!access.ok) notFound();

  // Whether to OFFER the Settings tab - and the Settings link in the empty
  // state. Not a guard - /bas/settings runs requireModuleAdmin itself and
  // 404s. This only stops the screen naming a surface that the 404 exists to
  // keep quiet about.
  const canAdminister = await hasModuleAdmin(access.viewer.id, BAS_MODULE_KEY);

  return (
    <BasShell blurb={basTab("/bas").blurb} canAdminister={canAdminister}>
      <Dashboard canAdminister={canAdminister} />
    </BasShell>
  );
}
