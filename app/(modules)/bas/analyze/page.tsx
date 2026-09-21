import { notFound } from "next/navigation";
import { hasModuleAdmin, requireModuleAccess } from "@/lib/authz";
import { BAS_MODULE_KEY } from "@/lib/modules/bas/constants";
import { Analyze } from "../analyze";
import { BasShell } from "../bas-shell";
import { basTab } from "../tabs";

export const dynamic = "force-dynamic";

/**
 * Analyze - the module's third tab, at /bas/analyze (B5).
 *
 * The BAS grant is enough; there is no module-admin requirement, because the
 * tab can read what the other two tabs read and nothing more - the `bas_analyze`
 * role sees the same allowlist Grafana does. It repeats the grant check rather
 * than inheriting one, for the same reason /bas and /bas/points do: reaching
 * the URL directly is the case that matters, and the tab bar is not involved.
 *
 * No layout wraps this, and none may. See settings/page.tsx.
 */
export default async function BasAnalyzePage() {
  const access = await requireModuleAccess(BAS_MODULE_KEY);
  if (!access.ok) notFound();

  const canAdminister = await hasModuleAdmin(access.viewer.id, BAS_MODULE_KEY);

  return (
    <BasShell blurb={basTab("/bas/analyze").blurb} canAdminister={canAdminister}>
      <Analyze />
    </BasShell>
  );
}
