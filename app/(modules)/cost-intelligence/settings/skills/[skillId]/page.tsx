import { notFound } from "next/navigation";
import { requireModuleAdmin } from "@/lib/authz";
import { COST_INTELLIGENCE_MODULE_KEY } from "@/lib/modules/cost-intelligence/constants";
import { CipShell } from "../../../cip-shell";
import { Skeleton } from "../../../skeleton";
import { SettingsNav } from "../../settings-nav";

export const dynamic = "force-dynamic";

export default async function SkillPage({ params }: { params: Promise<{ skillId: string }> }) {
  const access = await requireModuleAdmin(COST_INTELLIGENCE_MODULE_KEY);
  if (!access.ok) notFound();
  const { skillId } = await params;

  return (
    <CipShell canAdminister>
      <SettingsNav />
      <Skeleton
        title={`Skill ${skillId}`}
        items={[
          "Versions: live tag against main, with a diff",
          "Edit SKILL.md, saved as a commit to main",
          "Test against a fixture before publishing",
          "Publish a new tag. Running jobs keep the version they started with",
        ]}
      />
    </CipShell>
  );
}
