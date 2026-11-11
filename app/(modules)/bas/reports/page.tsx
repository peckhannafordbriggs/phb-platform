import { notFound } from "next/navigation";
import { hasModuleAdmin, requireModuleAccess } from "@/lib/authz";
import { BAS_MODULE_KEY } from "@/lib/modules/bas/constants";
import { BasShell } from "../bas-shell";
import { GeneratedView } from "../reports-generated";
import { basTab } from "../tabs";

export const dynamic = "force-dynamic";

/**
 * Reports - the module's tab at /bas/reports, opening on the runs
 * (2026-11-11; the list of definitions is /bas/reports/scheduled). The
 * shell draws the Reports bar in place of the module tabs for this path.
 *
 * The BAS grant is enough to reach the tab; which runs are listed is the
 * service's decision per row (owner, or module admin). Guarded here and not
 * by the tab bar, like every other BAS page, and no layout wraps it.
 */
export default async function BasReportsPage() {
  const access = await requireModuleAccess(BAS_MODULE_KEY);
  if (!access.ok) notFound();

  const canAdminister = await hasModuleAdmin(access.viewer.id, BAS_MODULE_KEY);

  return (
    <BasShell blurb={basTab("/bas/reports").blurb} canAdminister={canAdminister}>
      <GeneratedView />
    </BasShell>
  );
}
