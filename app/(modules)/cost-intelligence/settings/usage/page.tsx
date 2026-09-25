import { notFound } from "next/navigation";
import { requireModuleAdmin } from "@/lib/authz";
import { COST_INTELLIGENCE_MODULE_KEY } from "@/lib/modules/cost-intelligence/constants";
import { CipShell } from "../../cip-shell";
import { SettingsNav } from "../../settings/settings-nav";
import { SettingsTableView } from "../../views/settings-views";

export const dynamic = "force-dynamic";

export default async function UsagePage() {
  const access = await requireModuleAdmin(COST_INTELLIGENCE_MODULE_KEY);
  if (!access.ok) notFound();

  return (
    <CipShell canAdminister>
      <SettingsNav />
      <SettingsTableView headers={["Job", "Workflow", "Runs", "Tokens", "Cost"]} cols={["70%", "55%", 70, 70, 60]} stats={4} />
    </CipShell>
  );
}
