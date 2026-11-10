import { notFound } from "next/navigation";
import { hasModuleAdmin, requireModuleAccess } from "@/lib/authz";
import { BAS_MODULE_KEY } from "@/lib/modules/bas/constants";
import { BasShell } from "../../bas-shell";
import { ReportEditor } from "../../reports-editor";
import { ReportsShell } from "../../reports-shell";
import { basTab } from "../../tabs";

export const dynamic = "force-dynamic";

/** A new report. The viewer becomes its owner on the first save. */
export default async function NewBasReportPage() {
  const access = await requireModuleAccess(BAS_MODULE_KEY);
  if (!access.ok) notFound();

  const canAdminister = await hasModuleAdmin(access.viewer.id, BAS_MODULE_KEY);
  const { viewer } = access;

  return (
    <BasShell blurb={basTab("/bas/reports").blurb} canAdminister={canAdminister}>
      <ReportsShell>
        <ReportEditor
          reportId={null}
          viewer={{ email: viewer.email, name: `${viewer.firstName} ${viewer.lastName}`.trim() || viewer.email }}
        />
      </ReportsShell>
    </BasShell>
  );
}
