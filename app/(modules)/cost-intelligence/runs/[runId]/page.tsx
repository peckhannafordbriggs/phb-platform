import { notFound } from "next/navigation";
import { hasModuleAdmin, requireModuleAccess } from "@/lib/authz";
import { COST_INTELLIGENCE_MODULE_KEY } from "@/lib/modules/cost-intelligence/constants";
import { getRun } from "@/lib/modules/cost-intelligence/runs";
import { CipShell } from "../../cip-shell";
import { RunActions } from "../../header-actions";
import { RunMonitor } from "../../views/runs-view";

export const dynamic = "force-dynamic";

export default async function RunPage({ params }: { params: Promise<{ runId: string }> }) {
  const access = await requireModuleAccess(COST_INTELLIGENCE_MODULE_KEY);
  if (!access.ok) notFound();
  const canAdminister = await hasModuleAdmin(access.viewer.id, COST_INTELLIGENCE_MODULE_KEY);

  const run = await getRun((await params).runId);
  if (!run) notFound();

  return (
    <CipShell canAdminister={canAdminister} actions={<RunActions canAdminister={canAdminister} />}>
      <RunMonitor run={run} />
    </CipShell>
  );
}
