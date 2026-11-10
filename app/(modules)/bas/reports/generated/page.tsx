import { notFound } from "next/navigation";
import { hasModuleAdmin, requireModuleAccess } from "@/lib/authz";
import { BAS_MODULE_KEY } from "@/lib/modules/bas/constants";
import { BasShell } from "../../bas-shell";
import { GeneratedView } from "../../reports-generated";
import { ReportsShell } from "../../reports-shell";
import { basTab } from "../../tabs";

export const dynamic = "force-dynamic";

/** Generated - every run the viewer may see, newest first (Phase 2). */
export default async function BasReportsGeneratedPage() {
  const access = await requireModuleAccess(BAS_MODULE_KEY);
  if (!access.ok) notFound();

  const canAdminister = await hasModuleAdmin(access.viewer.id, BAS_MODULE_KEY);

  return (
    <BasShell blurb={basTab("/bas/reports").blurb} canAdminister={canAdminister}>
      <ReportsShell>
        <GeneratedView />
      </ReportsShell>
    </BasShell>
  );
}
