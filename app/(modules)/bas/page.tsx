import { notFound } from "next/navigation";
import { requireModuleAccess } from "@/lib/authz";
import { BAS_MODULE_KEY } from "@/lib/modules/bas/constants";
import { CollectionHealth } from "./collection-health";

export const dynamic = "force-dynamic";

/**
 * Collection Health, the module's landing screen.
 *
 * Guarded server-side, exactly like every route it calls. Navigating straight to
 * /bas without a grant must not render the module and must not reveal that it
 * exists - hence notFound() rather than a 403 screen. Hiding the sidebar item is
 * not authorization; this is.
 *
 * The screen itself is a client component because it polls. It fetches through
 * the module's own API route, which repeats this grant check independently.
 */
export default async function BasPage() {
  const access = await requireModuleAccess(BAS_MODULE_KEY);
  if (!access.ok) notFound();

  return (
    <div>
      <h1 className="text-xl font-semibold">Building Automation</h1>
      <p className="mt-1 max-w-3xl text-sm text-[var(--muted)]">
        Trended data from the building automation system, kept here because the
        controller itself keeps roughly two days and then overwrites. Past that
        point nothing anywhere holds the data, so this screen is about one
        question: is it arriving, and is any of it being lost.
      </p>

      <div className="mt-6">
        <CollectionHealth />
      </div>
    </div>
  );
}
