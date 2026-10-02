import { notFound } from "next/navigation";
import { requireModuleAdmin } from "@/lib/authz";
import { COST_INTELLIGENCE_MODULE_KEY } from "@/lib/modules/cost-intelligence/constants";
import { getPlaceholderSkill } from "@/lib/modules/cost-intelligence/placeholder-settings";
import { CipShell } from "../../../cip-shell";
import { NewRunActions } from "../../../header-actions";
import { SettingsNav } from "../../../settings/settings-nav";
import { SkillCatalogView } from "../../../views/skill-catalog-view";

export const dynamic = "force-dynamic";

export default async function SkillPage({ params }: { params: Promise<{ skillId: string }> }) {
  const access = await requireModuleAdmin(COST_INTELLIGENCE_MODULE_KEY);
  if (!access.ok) notFound();

  // TODO(backend): look the skill up in the catalog.
  const { skillId } = await params;
  if (!getPlaceholderSkill(skillId)) notFound();

  return (
    <CipShell canAdminister actions={<NewRunActions canAdminister />}>
      <SettingsNav />
      <SkillCatalogView selectedId={skillId} />
    </CipShell>
  );
}
