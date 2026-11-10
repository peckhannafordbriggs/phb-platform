import { notFound } from "next/navigation";
import { hasModuleAdmin, requireModuleAccess } from "@/lib/authz";
import { BAS_MODULE_KEY } from "@/lib/modules/bas/constants";
import { BasShell } from "../../bas-shell";
import { ReportEditor } from "../../reports-editor";
import { ReportsShell } from "../../reports-shell";
import { basTab } from "../../tabs";

export const dynamic = "force-dynamic";

/**
 * One report's editor. The id is digits or it is not a report; whether the
 * viewer may see THIS report is the API's answer when the editor loads it,
 * and a report that is not theirs reads as not found there too.
 */
export default async function BasReportPage({ params }: { params: Promise<{ reportId: string }> }) {
  const access = await requireModuleAccess(BAS_MODULE_KEY);
  if (!access.ok) notFound();

  const { reportId } = await params;
  if (!/^[0-9]{1,20}$/.test(reportId)) notFound();

  const canAdminister = await hasModuleAdmin(access.viewer.id, BAS_MODULE_KEY);
  const { viewer } = access;

  return (
    <BasShell blurb={basTab("/bas/reports").blurb} canAdminister={canAdminister}>
      <ReportsShell>
        <ReportEditor
          reportId={reportId}
          viewer={{ email: viewer.email, name: `${viewer.firstName} ${viewer.lastName}`.trim() || viewer.email }}
        />
      </ReportsShell>
    </BasShell>
  );
}
