import { notFound } from "next/navigation";
import { hasModuleAdmin, requireModuleAccess } from "@/lib/authz";
import { COST_INTELLIGENCE_MODULE_KEY } from "@/lib/modules/cost-intelligence/constants";
import { listLaunchOptions, listRuns } from "@/lib/modules/cost-intelligence/runs";
import { CipShell } from "./cip-shell";
import { NewRunActions } from "./header-actions";
import { RunsView } from "./views/runs-view";

export const dynamic = "force-dynamic";

export default async function RunsPage({ searchParams }: { searchParams: Promise<{ new?: string }> }) {
  const access = await requireModuleAccess(COST_INTELLIGENCE_MODULE_KEY);
  if (!access.ok) notFound();
  const canAdminister = await hasModuleAdmin(access.viewer.id, COST_INTELLIGENCE_MODULE_KEY);
  const launcherOpen = (await searchParams).new !== undefined;

  const [runs, options] = await Promise.all([listRuns(), launcherOpen ? listLaunchOptions() : null]);

  return (
    <CipShell canAdminister={canAdminister} actions={<NewRunActions launcherOpen={launcherOpen} canAdminister={canAdminister} />}>
      <RunsView runs={runs} options={options} />
    </CipShell>
  );
}
