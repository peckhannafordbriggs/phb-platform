import { notFound } from "next/navigation";
import { hasModuleAdmin, requireModuleAccess } from "@/lib/authz";
import { COST_INTELLIGENCE_MODULE_KEY } from "@/lib/modules/cost-intelligence/constants";
import { CipShell } from "./cip-shell";
import { Bar, Button } from "./skeleton";
import { RunsView } from "./views/runs-view";

export const dynamic = "force-dynamic";

export default async function RunsPage() {
  const access = await requireModuleAccess(COST_INTELLIGENCE_MODULE_KEY);
  if (!access.ok) notFound();
  const canAdminister = await hasModuleAdmin(access.viewer.id, COST_INTELLIGENCE_MODULE_KEY);

  return (
    <CipShell canAdminister={canAdminister} actions={<><div className="flex h-9 w-60 items-center rounded-[var(--radius-control)] border border-[var(--border)] bg-white px-3"><Bar w="60%" h={8} /></div><Button w={112} filled /></>}>
      <RunsView />
    </CipShell>
  );
}
