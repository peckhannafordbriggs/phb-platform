import { notFound } from "next/navigation";
import { hasModuleAdmin, requireModuleAccess } from "@/lib/authz";
import { COST_INTELLIGENCE_MODULE_KEY } from "@/lib/modules/cost-intelligence/constants";
import { CipShell } from "../../cip-shell";
import { JobView } from "../../views/job-view";

export const dynamic = "force-dynamic";

export default async function JobPage() {
  const access = await requireModuleAccess(COST_INTELLIGENCE_MODULE_KEY);
  if (!access.ok) notFound();
  const canAdminister = await hasModuleAdmin(access.viewer.id, COST_INTELLIGENCE_MODULE_KEY);

  return (
    <CipShell canAdminister={canAdminister}>
      <JobView />
    </CipShell>
  );
}
