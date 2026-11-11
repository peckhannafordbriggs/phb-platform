import { notFound } from "next/navigation";
import { hasModuleAdmin, requireModuleAccess } from "@/lib/authz";
import { BAS_MODULE_KEY } from "@/lib/modules/bas/constants";
import { BasShell } from "../../bas-shell";
import { UsagePlaceholder } from "../../reports-placeholders";
import { basTab } from "../../tabs";

export const dynamic = "force-dynamic";

/** Usage - spend and time per run, once there are runs. Says so until then. */
export default async function BasReportsUsagePage() {
  const access = await requireModuleAccess(BAS_MODULE_KEY);
  if (!access.ok) notFound();

  const canAdminister = await hasModuleAdmin(access.viewer.id, BAS_MODULE_KEY);

  return (
    <BasShell blurb={basTab("/bas/reports").blurb} canAdminister={canAdminister}>
      <UsagePlaceholder />
    </BasShell>
  );
}
