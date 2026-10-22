import { notFound } from "next/navigation";
import { requireModuleAccess } from "@/lib/authz";
import { FREEZE_PROTECTION_MODULE_KEY } from "@/lib/modules/freeze-protection/constants";
import { FpShell } from "../fp-shell";
import { ReportView } from "../views/report-view";

export const dynamic = "force-dynamic";

export default async function ReportPage() {
  const access = await requireModuleAccess(FREEZE_PROTECTION_MODULE_KEY);
  if (!access.ok) notFound();

  // No service layer yet, so there is nothing to load: the report shows its empty state.
  return (
    <FpShell>
      <ReportView project={null} equipment={[]} />
    </FpShell>
  );
}
