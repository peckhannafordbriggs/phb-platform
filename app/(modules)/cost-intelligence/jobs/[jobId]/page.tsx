import { notFound } from "next/navigation";
import { hasModuleAdmin, requireModuleAccess } from "@/lib/authz";
import { COST_INTELLIGENCE_MODULE_KEY } from "@/lib/modules/cost-intelligence/constants";
import { CipShell } from "../../cip-shell";
import { Skeleton } from "../../skeleton";

export const dynamic = "force-dynamic";

export default async function JobPage({ params }: { params: Promise<{ jobId: string }> }) {
  const access = await requireModuleAccess(COST_INTELLIGENCE_MODULE_KEY);
  if (!access.ok) notFound();
  const canAdminister = await hasModuleAdmin(access.viewer.id, COST_INTELLIGENCE_MODULE_KEY);
  const { jobId } = await params;

  return (
    <CipShell canAdminister={canAdminister}>
      <Skeleton
        title={`Job ${jobId}`}
        items={[
          "Job header: number, name, SharePoint path, folder sync time, refresh, switch job",
          "Skill pipeline for this job",
          "Job memory: decisions carried into every run",
          "Files: AI FILES and the read-only SharePoint folders",
          "Waiting on you: pending decisions across this job's runs",
          "New run for this job",
        ]}
      />
    </CipShell>
  );
}
