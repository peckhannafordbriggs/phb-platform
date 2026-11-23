import { notFound } from "next/navigation";
import { hasModuleAdmin, requireModuleAccess } from "@/lib/authz";
import { BAS_MODULE_KEY } from "@/lib/modules/bas/constants";
import { BasShell } from "../../bas-shell";
import { RecentlyDeletedView } from "../../reports-deleted";
import { basTab } from "../../tabs";

export const dynamic = "force-dynamic";

/**
 * Recently deleted (2026-11-20), opened from the button above the runs on
 * /bas/reports; the Reports bar keeps Reports selected here. Which deleted
 * runs are listed is the service's decision per row (owner, or module
 * admin), as on the list itself.
 */
export default async function BasReportsDeletedPage() {
  const access = await requireModuleAccess(BAS_MODULE_KEY);
  if (!access.ok) notFound();

  const canAdminister = await hasModuleAdmin(access.viewer.id, BAS_MODULE_KEY);

  return (
    <BasShell blurb={basTab("/bas/reports").blurb} canAdminister={canAdminister}>
      <RecentlyDeletedView />
    </BasShell>
  );
}
