import { notFound } from "next/navigation";
import { requireModuleAdmin } from "@/lib/authz";
import { COST_INTELLIGENCE_MODULE_KEY } from "@/lib/modules/cost-intelligence/constants";
import { getUsage, parseUsageRange } from "@/lib/modules/cost-intelligence/usage";
import { CipShell } from "../../cip-shell";
import { NewRunActions } from "../../header-actions";
import { SettingsNav } from "../../settings/settings-nav";
import { UsageView } from "../../views/usage-view";

export const dynamic = "force-dynamic";

export default async function UsagePage({ searchParams }: { searchParams: Promise<{ range?: string }> }) {
  const access = await requireModuleAdmin(COST_INTELLIGENCE_MODULE_KEY);
  if (!access.ok) notFound();
  const usage = await getUsage(parseUsageRange((await searchParams).range));

  return (
    <CipShell canAdminister actions={<NewRunActions canAdminister />}>
      <SettingsNav />
      <UsageView usage={usage} />
    </CipShell>
  );
}
