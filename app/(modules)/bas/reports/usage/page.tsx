import { notFound } from "next/navigation";
import { hasModuleAdmin, requireModuleAccess } from "@/lib/authz";
import { BAS_MODULE_KEY } from "@/lib/modules/bas/constants";
import { getReportsUsage } from "@/lib/modules/bas/reports/usage";
import { parseUsageRange } from "@/lib/usage/range";
import { BasShell } from "../../bas-shell";
import { ReportsUsageView } from "../../reports-usage";
import { basTab } from "../../tabs";

export const dynamic = "force-dynamic";

/**
 * Usage - spend, runs and tokens over 7 / 30 / 90 days, by report and by
 * building, and the module's safety ceiling (2026-11-12). Server-rendered
 * from the service, like Cost Intelligence's; the range is `?range=`.
 */
export default async function BasReportsUsagePage({ searchParams }: { searchParams: Promise<{ range?: string }> }) {
  const access = await requireModuleAccess(BAS_MODULE_KEY);
  if (!access.ok) notFound();

  const [canAdminister, usage] = await Promise.all([
    hasModuleAdmin(access.viewer.id, BAS_MODULE_KEY),
    getReportsUsage(access.viewer, parseUsageRange((await searchParams).range)),
  ]);

  return (
    <BasShell blurb={basTab("/bas/reports").blurb} canAdminister={canAdminister}>
      <ReportsUsageView usage={usage} canAdminister={canAdminister} />
    </BasShell>
  );
}
