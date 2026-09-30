import { notFound } from "next/navigation";
import { hasModuleAdmin, requireModuleAccess } from "@/lib/authz";
import { COST_INTELLIGENCE_MODULE_KEY } from "@/lib/modules/cost-intelligence/constants";
import { CipShell } from "./cip-shell";
import { NewRunActions } from "./header-actions";
import { RunsView } from "./views/runs-view";

export const dynamic = "force-dynamic";

export default async function RunsPage({
  searchParams,
}: {
  searchParams: Promise<{ new?: string }>;
}) {
  const access = await requireModuleAccess(COST_INTELLIGENCE_MODULE_KEY);
  if (!access.ok) notFound();
  const canAdminister = await hasModuleAdmin(access.viewer.id, COST_INTELLIGENCE_MODULE_KEY);
  const launcherOpen = (await searchParams).new !== undefined;

  return (
    <CipShell canAdminister={canAdminister} actions={<NewRunActions launcherOpen={launcherOpen} />}>
      <RunsView />
    </CipShell>
  );
}
