import { notFound } from "next/navigation";
import { hasModuleAdmin, requireModuleAccess } from "@/lib/authz";
import { BAS_MODULE_KEY } from "@/lib/modules/bas/constants";
import { BasShell } from "../../bas-shell";
import { ReportsLibraryView } from "../../reports-library";
import { basTab } from "../../tabs";

export const dynamic = "force-dynamic";

/**
 * Questions - the shared questions, read-only, and the viewer's own. On
 * screen it is Questions (2026-11-11); the route and the tables keep the
 * name Library, so every link and identifier stays.
 */
export default async function BasReportsLibraryPage() {
  const access = await requireModuleAccess(BAS_MODULE_KEY);
  if (!access.ok) notFound();

  const canAdminister = await hasModuleAdmin(access.viewer.id, BAS_MODULE_KEY);

  return (
    <BasShell blurb={basTab("/bas/reports").blurb} canAdminister={canAdminister}>
      <ReportsLibraryView />
    </BasShell>
  );
}
