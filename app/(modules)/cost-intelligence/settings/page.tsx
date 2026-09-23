import { notFound } from "next/navigation";
import { requireModuleAdmin } from "@/lib/authz";
import { COST_INTELLIGENCE_MODULE_KEY } from "@/lib/modules/cost-intelligence/constants";
import { CipShell } from "../cip-shell";
import { SettingsNav } from "./settings-nav";
import { SkillCatalogView } from "../views/settings-views";

export const dynamic = "force-dynamic";

export default async function SkillCatalogPage() {
  const access = await requireModuleAdmin(COST_INTELLIGENCE_MODULE_KEY);
  if (!access.ok) notFound();

  return (
    <CipShell canAdminister>
      <SettingsNav />
      <SkillCatalogView />
    </CipShell>
  );
}
