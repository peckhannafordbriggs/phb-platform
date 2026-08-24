import { notFound } from "next/navigation";
import { requireModuleAccess } from "@/lib/authz";
import { BAS_MODULE_KEY } from "@/lib/modules/bas/constants";
import { BasShell } from "../bas-shell";
import { PointExplorer } from "../point-explorer";
import { basTab } from "../tabs";

export const dynamic = "force-dynamic";

/**
 * Point Explorer - the module's second tab, at /bas/points.
 *
 * A real route, so it is bookmarkable, survives a refresh, and opens in a new
 * tab from a middle-click. It repeats the grant check rather than inheriting one
 * from the tab bar, for the same reason /bas does: reaching a URL directly is
 * the case that matters, and the tab bar is not involved in it.
 */
export default async function BasPointsPage() {
  const access = await requireModuleAccess(BAS_MODULE_KEY);
  if (!access.ok) notFound();

  return (
    <BasShell blurb={basTab("/bas/points").blurb}>
      <PointExplorer />
    </BasShell>
  );
}
