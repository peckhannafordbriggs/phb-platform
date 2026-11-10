import { notFound } from "next/navigation";
import { hasModuleAdmin, requireModuleAccess } from "@/lib/authz";
import { BAS_MODULE_KEY } from "@/lib/modules/bas/constants";
import { BasShell } from "../../bas-shell";
import { GeneratedPlaceholder } from "../../reports-placeholders";
import { ReportsShell } from "../../reports-shell";
import { basTab } from "../../tabs";

export const dynamic = "force-dynamic";

/** Generated - every run, once there are runs (Phase 2). Says so until then. */
export default async function BasReportsGeneratedPage() {
  const access = await requireModuleAccess(BAS_MODULE_KEY);
  if (!access.ok) notFound();

  const canAdminister = await hasModuleAdmin(access.viewer.id, BAS_MODULE_KEY);

  return (
    <BasShell blurb={basTab("/bas/reports").blurb} canAdminister={canAdminister}>
      <ReportsShell>
        <GeneratedPlaceholder />
      </ReportsShell>
    </BasShell>
  );
}
