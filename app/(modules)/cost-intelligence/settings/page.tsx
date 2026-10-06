import { notFound } from "next/navigation";
import { requireModuleAdmin } from "@/lib/authz";
import { COST_INTELLIGENCE_MODULE_KEY } from "@/lib/modules/cost-intelligence/constants";
import { getLatestSkillSync, listCatalogSkills } from "@/lib/modules/cost-intelligence/skill-sync";
import { CipShell } from "../cip-shell";
import { NewRunActions } from "../header-actions";
import { SettingsNav } from "./settings-nav";
import { SkillCatalogView } from "../views/skill-catalog-view";

export const dynamic = "force-dynamic";

export default async function SkillCatalogPage() {
  const access = await requireModuleAdmin(COST_INTELLIGENCE_MODULE_KEY);
  if (!access.ok) notFound();

  const [skills, lastSync] = await Promise.all([listCatalogSkills(), getLatestSkillSync()]);

  return (
    <CipShell canAdminister actions={<NewRunActions canAdminister />}>
      <SettingsNav />
      <SkillCatalogView skills={skills} selected={skills[0] ?? null} lastSync={lastSync} />
    </CipShell>
  );
}
