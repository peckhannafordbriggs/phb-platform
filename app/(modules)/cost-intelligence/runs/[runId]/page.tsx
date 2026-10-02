import { notFound } from "next/navigation";
import { hasModuleAdmin, requireModuleAccess } from "@/lib/authz";
import { COST_INTELLIGENCE_MODULE_KEY } from "@/lib/modules/cost-intelligence/constants";
import { CipShell } from "../../cip-shell";
import { RunActions } from "../../header-actions";
import { getPlaceholderActivity, getPlaceholderRun } from "@/lib/modules/cost-intelligence/placeholder";
import type { Run, RunActivity } from "@/lib/modules/cost-intelligence/types";
import { RunMonitor } from "../../views/parts";

export const dynamic = "force-dynamic";

function getRunById(runId: string): Run | undefined {
  // TODO(backend): Fetch the run by its ID from the backend.
  return getPlaceholderRun(runId);
}

function getRunActivity(runId: string): RunActivity | undefined {
  // TODO(backend): Load the run's ledger, steps, pinned skills and cost.
  return getPlaceholderActivity(runId);
}

export default async function RunPage({ params }: { params: Promise<{ runId: string }> }) {
  const access = await requireModuleAccess(COST_INTELLIGENCE_MODULE_KEY);
  if (!access.ok) notFound();
  const canAdminister = await hasModuleAdmin(access.viewer.id, COST_INTELLIGENCE_MODULE_KEY);

  const { runId } = await params;
  const run = getRunById(runId);
  if (!run) notFound();

  return (
    <CipShell canAdminister={canAdminister} actions={<RunActions canAdminister={canAdminister} />}>
      <RunMonitor run={run} activity={getRunActivity(runId)} />
    </CipShell>
  );
}
