import { notFound } from "next/navigation";
import { hasModuleAdmin, requireModuleAccess } from "@/lib/authz";
import { BAS_MODULE_KEY } from "@/lib/modules/bas/constants";
import { BasShell } from "../../bas-shell";
import { ReportsListView } from "../../reports-list";
import { basTab } from "../../tabs";

export const dynamic = "force-dynamic";

/**
 * Scheduled - the report definitions the viewer may see, one row each, with
 * New report top right (2026-11-11; this list was /bas/reports until the
 * Reports bar). The editor at /bas/reports/new and /bas/reports/<id>
 * belongs to this item.
 */
export default async function BasScheduledReportsPage() {
  const access = await requireModuleAccess(BAS_MODULE_KEY);
  if (!access.ok) notFound();

  const canAdminister = await hasModuleAdmin(access.viewer.id, BAS_MODULE_KEY);

  return (
    <BasShell blurb={basTab("/bas/reports").blurb} canAdminister={canAdminister}>
      <ReportsListView />
    </BasShell>
  );
}
