import { notFound } from "next/navigation";
import { hasModuleAdmin, requireModuleAccess } from "@/lib/authz";
import { COST_INTELLIGENCE_MODULE_KEY } from "@/lib/modules/cost-intelligence/constants";
import { CipShell } from "../../cip-shell";
import { Skeleton } from "../../skeleton";

export const dynamic = "force-dynamic";

export default async function RunPage({ params }: { params: Promise<{ runId: string }> }) {
  const access = await requireModuleAccess(COST_INTELLIGENCE_MODULE_KEY);
  if (!access.ok) notFound();
  const canAdminister = await hasModuleAdmin(access.viewer.id, COST_INTELLIGENCE_MODULE_KEY);
  const { runId } = await params;

  return (
    <CipShell canAdminister={canAdminister}>
      <Skeleton
        title={`Run ${runId}`}
        items={[
          "Status and step timeline: queued, preparing files, running, awaiting decision, awaiting Excel save, writing outputs, completed",
          "Decision checkpoint: answer and resume",
          "Excel save checkpoint: recalculate, save, continue",
          "Failure with retry",
          "Outputs saved to AI FILES",
          "Pinned skill versions, tokens used, estimated cost",
          "Cancel run",
        ]}
      />
    </CipShell>
  );
}
