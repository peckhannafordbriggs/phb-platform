import { notFound } from "next/navigation";
import { requireModuleAdmin } from "@/lib/authz";
import { BAS_MODULE_KEY } from "@/lib/modules/bas/constants";
import { getReportsUsage } from "@/lib/modules/bas/reports/usage";
import { parseUsageRange } from "@/lib/usage/range";
import { BasShell } from "../../bas-shell";
import { ReportsUsageView } from "../../reports-usage";
import { basTab } from "../../tabs";

export const dynamic = "force-dynamic";

/**
 * Settings → Usage (2026-11-12): the same view as Reports → Usage - spend,
 * runs and tokens over 7 / 30 / 90 days, by report and by building, and the
 * module's safety ceiling - at a second route, under the Settings bar the
 * shell draws for every path under /bas/settings (Back · General · Usage).
 * One component, two routes; the Reports bar is unchanged.
 *
 * `requireModuleAdmin`, like every Settings page, and no layout around it
 * (app/(modules)/bas/settings/page.tsx says why). A module admin is what
 * the ceiling card needs to be editable, so `canAdminister` is a literal.
 */
export default async function BasSettingsUsagePage({ searchParams }: { searchParams: Promise<{ range?: string }> }) {
  const access = await requireModuleAdmin(BAS_MODULE_KEY);
  if (!access.ok) notFound();

  const usage = await getReportsUsage(access.viewer, parseUsageRange((await searchParams).range));

  return (
    <BasShell blurb={basTab("/bas/settings").blurb} canAdminister>
      <ReportsUsageView usage={usage} canAdminister />
    </BasShell>
  );
}
