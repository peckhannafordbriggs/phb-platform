import { notFound } from "next/navigation";
import { requireModuleAdmin } from "@/lib/authz";
import { BAS_MODULE_KEY } from "@/lib/modules/bas/constants";
import { BasShell } from "../bas-shell";
import { BasSettings } from "../settings-view";
import { basTab } from "../tabs";

export const dynamic = "force-dynamic";

/**
 * Settings - the module's third tab, at /bas/settings. Read-only in B7.2.
 *
 * `requireModuleAdmin`, not `requireModuleAccess`: the BAS grant is not enough,
 * the grant has to carry `is_module_admin`. A BAS user without it gets 404 here
 * and 404 from every settings route, because the platform does not confirm to
 * someone who cannot use it that a module's administrative surface exists.
 *
 * THERE IS NO LAYOUT AROUND THIS, and there must never be. A Next.js layout
 * renders around a page that calls `notFound()`, so an ungranted employee would
 * get the Building Automation heading and the tab bar wrapped around a 404 body
 * - which confirms the tab exists to exactly the person it is hidden from. The
 * chrome comes from `BasShell` INSIDE this guarded component, so a 404 renders
 * as a bare 404. That is also why the check is repeated here rather than
 * inherited: reaching this URL directly is the case that matters, and the tab
 * bar is not involved in it.
 *
 * `canAdminister` is passed as a literal `true` rather than looked up again -
 * anything reaching this line has already proved it.
 */
export default async function BasSettingsPage() {
  const access = await requireModuleAdmin(BAS_MODULE_KEY);
  if (!access.ok) notFound();

  return (
    <BasShell blurb={basTab("/bas/settings").blurb} canAdminister>
      <BasSettings />
    </BasShell>
  );
}
