import Link from "next/link";
import { notFound } from "next/navigation";
import { hasModuleAdmin, requireModuleAccess } from "@/lib/authz";
import { COST_INTELLIGENCE_MODULE_KEY } from "@/lib/modules/cost-intelligence/constants";
import { CipShell } from "../cip-shell";
import { Skeleton } from "../skeleton";

export const dynamic = "force-dynamic";

export default async function JobsPage() {
  const access = await requireModuleAccess(COST_INTELLIGENCE_MODULE_KEY);
  if (!access.ok) notFound();
  const canAdminister = await hasModuleAdmin(access.viewer.id, COST_INTELLIGENCE_MODULE_KEY);

  return (
    <CipShell canAdminister={canAdminister}>
      <Skeleton
        title="Jobs"
        items={["Jobs you can open in SharePoint, searchable by number or name"]}
      >
        <Link href="/cost-intelligence/jobs/example" className="underline">Example job</Link>
      </Skeleton>
    </CipShell>
  );
}
