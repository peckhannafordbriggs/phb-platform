import { notFound } from "next/navigation";
import { requireModuleAdmin } from "@/lib/authz";
import { COST_INTELLIGENCE_MODULE_KEY } from "@/lib/modules/cost-intelligence/constants";
import { CipShell } from "../../../cip-shell";
import { NewRunActions } from "../../../header-actions";
import { SettingsNav } from "../../../settings/settings-nav";
import { SkillView } from "../../../views/settings-views";

export const dynamic = "force-dynamic";

export default async function SkillPage() {
  const access = await requireModuleAdmin(COST_INTELLIGENCE_MODULE_KEY);
  if (!access.ok) notFound();

  return (
    <CipShell canAdminister actions={<NewRunActions />}>
      <SettingsNav />
      <SkillView />
    </CipShell>
  );
}
