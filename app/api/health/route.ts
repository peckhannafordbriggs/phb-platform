import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The container liveness and readiness probe.
 *
 * Unauthenticated by necessity - Container Apps has no session - and therefore
 * deliberately mute. It reports that this process is serving HTTP and nothing
 * else: no version, no environment, no dependency status, no configuration. An
 * unauthenticated endpoint is an unauthenticated endpoint whoever is asking.
 *
 * It does NOT touch the database, and that is the important decision. A probe
 * that fails when Postgres is briefly unreachable makes Container Apps restart
 * a process that was working, turning a short database blip into a restart loop
 * that outlasts it. Liveness answers "should this process be killed", and the
 * answer to that is no. Database health is diagnosed from the application logs
 * and runbook.md.
 *
 * Not to be confused with /api/modules/change-orders/mailbox/health, which is
 * grant-gated and reports configuration state. That one answers "can we reach
 * the mailbox"; this one answers "is anything listening".
 */
export function GET() {
  return NextResponse.json(
    { status: "ok" },
    // Probes must never be served from a cache, or a dead process keeps
    // answering for as long as something upstream remembers the last 200.
    { status: 200, headers: { "Cache-Control": "no-store" } },
  );
}
