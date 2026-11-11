import Link from "next/link";
import { notFound } from "next/navigation";
import { hasModuleAdmin, requireModuleAccess } from "@/lib/authz";
import { BAS_MODULE_KEY } from "@/lib/modules/bas/constants";
import { BasError } from "@/lib/modules/bas/errors";
import { REPORT_CSS, ReportView } from "@/lib/modules/bas/reports/engine/render";
import { getRun } from "@/lib/modules/bas/reports/runs-service";
import { BasShell } from "../../../bas-shell";
import { basTab } from "../../../tabs";

export const dynamic = "force-dynamic";

/**
 * One generated report (Phase 2): the run's stored document, rendered by the
 * same template the standalone HTML uses. Guarded like every BAS page; the
 * run is read through the service, which answers not-found for a run whose
 * report is not the viewer's.
 */
export default async function BasReportRunPage({ params }: { params: Promise<{ runId: string }> }) {
  const access = await requireModuleAccess(BAS_MODULE_KEY);
  if (!access.ok) notFound();

  const { runId } = await params;
  let run;
  try {
    run = await getRun(access.viewer, runId);
  } catch (error) {
    if (error instanceof BasError && error.code === "run_not_found") notFound();
    throw error;
  }

  const canAdminister = await hasModuleAdmin(access.viewer.id, BAS_MODULE_KEY);

  return (
    <BasShell blurb={basTab("/bas/reports").blurb} canAdminister={canAdminister}>
      <div className="space-y-4">
        <Link href="/bas/reports" className="text-sm text-[var(--muted)] hover:underline">
          ← All reports
        </Link>
        {run.document === null ? (
          <section className="card p-8 text-center">
            <p className="text-sm font-medium">This run has no report</p>
            <p className="mt-1 text-sm text-[var(--muted)]">
              {run.status === "failed" ? `It failed: ${run.error ?? "no error recorded"}.` : `It is ${run.status}.`}
            </p>
          </section>
        ) : (
          <section className="card p-6">
            <style>{REPORT_CSS}</style>
            <ReportView document={run.document} />
          </section>
        )}
      </div>
    </BasShell>
  );
}
