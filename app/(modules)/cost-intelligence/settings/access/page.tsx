import { notFound } from "next/navigation";
import { requireModuleAdmin } from "@/lib/authz";
import { COST_INTELLIGENCE_MODULE_KEY } from "@/lib/modules/cost-intelligence/constants";
import { CipShell } from "../../cip-shell";
import { NewRunActions } from "../../header-actions";
import { SettingsNav } from "../../settings/settings-nav";
import { SettingsTableView } from "../../views/settings-views";

export const dynamic = "force-dynamic";

export default async function AccessPage() {
  const access = await requireModuleAdmin(COST_INTELLIGENCE_MODULE_KEY);
  if (!access.ok) notFound();

  return (
    <CipShell canAdminister actions={<NewRunActions />}>
      <SettingsNav />
      <SettingsTableView headers={["Employee", "Role", "Granted", "Last active"]} cols={["75%", "60%", 100, 80]} rows={8} />
    </CipShell>
  );
}
