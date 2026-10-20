import { notFound } from "next/navigation";
import { requireModuleAdmin } from "@/lib/authz";
import { COST_INTELLIGENCE_MODULE_KEY } from "@/lib/modules/cost-intelligence/constants";
import { getLatestSkillSync, listCatalogSkills } from "@/lib/modules/cost-intelligence/skill-sync";
import { CipShell } from "../../../cip-shell";
import { NewRunActions } from "../../../header-actions";
import { SettingsNav } from "../../../settings/settings-nav";
import { SkillCatalogView } from "../../../views/skill-catalog-view";

export const dynamic = "force-dynamic";

export default async function SkillPage({ params }: { params: Promise<{ skillId: string }> }) {
  const access = await requireModuleAdmin(COST_INTELLIGENCE_MODULE_KEY);
  if (!access.ok) notFound();

  const { skillId } = await params;
  const [skills, lastSync] = await Promise.all([listCatalogSkills(), getLatestSkillSync()]);
  const selected = skills.find((s) => s.folderName === decodeURIComponent(skillId));
  if (!selected) notFound();

  return (
    <CipShell canAdminister actions={<NewRunActions canAdminister />}>
      <SettingsNav />
      <SkillCatalogView skills={skills} selected={selected} lastSync={lastSync} />
    </CipShell>
  );
}
