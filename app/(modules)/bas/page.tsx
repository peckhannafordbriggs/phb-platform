import { notFound } from "next/navigation";
import { requireModuleAccess } from "@/lib/authz";
import { BAS_MODULE_KEY } from "@/lib/modules/bas/constants";

export const dynamic = "force-dynamic";

/**
 * Placeholder. Collection Health is B3 and Point Explorer is B4; this page
 * exists now so the sidebar item leads somewhere and so the page guard is
 * written and tested before there is a screen to hide behind it.
 *
 * Guarded server-side, exactly like every route it will call. Navigating
 * straight to /bas without a grant must not render the module and must not
 * reveal that it exists - hence notFound() rather than a 403 screen. Hiding the
 * sidebar item is not authorization; this is.
 */
export default async function BasPage() {
  const access = await requireModuleAccess(BAS_MODULE_KEY);
  if (!access.ok) notFound();

  return (
    <div>
      <h1 className="text-xl font-semibold">Building Automation</h1>
      <p className="mt-1 text-sm text-[var(--muted)]">
        Trended data from the building automation system, kept here because the
        controller itself keeps roughly two days and then overwrites.
      </p>

      <div className="mt-6 rounded border border-[var(--border)] bg-[var(--surface)] p-4">
        <p className="text-sm font-medium">No screens yet</p>
        <p className="mt-1 text-sm text-[var(--muted)]">
          The data is loaded and this module is registered. Collection Health and
          Point Explorer are the next two steps.
        </p>
      </div>
    </div>
  );
}
