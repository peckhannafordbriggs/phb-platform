import { notFound, redirect } from "next/navigation";
import { requireModuleAccess } from "@/lib/authz";
import { BAS_MODULE_KEY } from "@/lib/modules/bas/constants";

export const dynamic = "force-dynamic";

/**
 * The runs moved to /bas/reports on 2026-11-11, when the Reports bar made
 * them the tab's default view. An old link lands on the same list. The
 * grant is checked first, so a person without it gets the module's 404
 * here as everywhere, never a redirect that admits the route exists.
 */
export default async function BasReportsGeneratedPage() {
  const access = await requireModuleAccess(BAS_MODULE_KEY);
  if (!access.ok) notFound();

  redirect("/bas/reports");
}
