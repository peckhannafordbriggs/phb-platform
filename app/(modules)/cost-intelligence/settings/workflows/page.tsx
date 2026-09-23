import { notFound } from "next/navigation";
import { requireModuleAdmin } from "@/lib/authz";
import { COST_INTELLIGENCE_MODULE_KEY } from "@/lib/modules/cost-intelligence/constants";
import { CipShell } from "../../cip-shell";
import { Skeleton } from "../../skeleton";
import { SettingsNav } from "../../settings/settings-nav";

export const dynamic = "force-dynamic";

export default async function WorkflowsPage() {
  const access = await requireModuleAdmin(COST_INTELLIGENCE_MODULE_KEY);
  if (!access.ok) notFound();

  return (
    <CipShell canAdminister>
      <SettingsNav />
      <Skeleton
        title="Workflows"
        items={[
          "Published workflows and the skills each one chains",
        ]}
      ></Skeleton>
    </CipShell>
  );
}
