import { notFound } from "next/navigation";
import { requireModuleAccess } from "@/lib/authz";
import { BAS_MODULE_KEY } from "@/lib/modules/bas/constants";
import { BasShell } from "./bas-shell";
import { CollectionHealth } from "./collection-health";
import { basTab } from "./tabs";

export const dynamic = "force-dynamic";

/**
 * Collection Health - the module's first tab, at /bas.
 *
 * Guarded here, on this route, and not by the tab bar. A tab bar is navigation;
 * every route behind it carries its own guard and so does every API route it
 * calls. Navigating straight to /bas without a grant must not render the module
 * and must not reveal that it exists - hence notFound() rather than a 403.
 */
export default async function BasPage() {
  const access = await requireModuleAccess(BAS_MODULE_KEY);
  if (!access.ok) notFound();

  return (
    <BasShell blurb={basTab("/bas").blurb}>
      <CollectionHealth />
    </BasShell>
  );
}
