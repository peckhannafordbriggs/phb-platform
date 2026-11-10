import { notFound } from "next/navigation";
import { hasModuleAdmin, requireModuleAccess } from "@/lib/authz";
import { BAS_MODULE_KEY } from "@/lib/modules/bas/constants";
import { BasShell } from "../../bas-shell";
import { ReportsLibraryView } from "../../reports-library";
import { ReportsShell } from "../../reports-shell";
import { basTab } from "../../tabs";

export const dynamic = "force-dynamic";

/** Library - the shared questions, read-only, and the viewer's own. */
export default async function BasReportsLibraryPage() {
  const access = await requireModuleAccess(BAS_MODULE_KEY);
  if (!access.ok) notFound();

  const canAdminister = await hasModuleAdmin(access.viewer.id, BAS_MODULE_KEY);

  return (
    <BasShell blurb={basTab("/bas/reports").blurb} canAdminister={canAdminister}>
      <ReportsShell>
        <ReportsLibraryView />
      </ReportsShell>
    </BasShell>
  );
}
