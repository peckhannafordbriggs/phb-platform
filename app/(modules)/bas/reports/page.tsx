import { notFound } from "next/navigation";
import { hasModuleAdmin, requireModuleAccess } from "@/lib/authz";
import { BAS_MODULE_KEY } from "@/lib/modules/bas/constants";
import { BasShell } from "../bas-shell";
import { ReportsListView } from "../reports-list";
import { ReportsShell } from "../reports-shell";
import { basTab } from "../tabs";

export const dynamic = "force-dynamic";

/**
 * Reports - the module's tab at /bas/reports (Phase 1), opening on the list.
 *
 * The BAS grant is enough to reach the tab; which reports are listed is the
 * service's decision per row (owner, or module admin). Guarded here and not
 * by the tab bar, like every other BAS page, and no layout wraps it.
 */
export default async function BasReportsPage() {
  const access = await requireModuleAccess(BAS_MODULE_KEY);
  if (!access.ok) notFound();

  const canAdminister = await hasModuleAdmin(access.viewer.id, BAS_MODULE_KEY);

  return (
    <BasShell blurb={basTab("/bas/reports").blurb} canAdminister={canAdminister}>
      <ReportsShell>
        <ReportsListView />
      </ReportsShell>
    </BasShell>
  );
}
