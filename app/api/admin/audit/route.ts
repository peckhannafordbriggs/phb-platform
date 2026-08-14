import type { NextRequest } from "next/server";
import { ok } from "@/lib/api/response";
import { invalidBody, withAdmin } from "@/lib/admin/route-helpers";
import { listAuditEvents } from "@/lib/admin/service";
import { auditQuerySchema, searchParamsToObject } from "@/lib/validation/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Read-only by design. There is no PATCH and no DELETE here, and the database
// refuses both anyway - see the audit_append_only migration.
export async function GET(request: NextRequest) {
  return withAdmin("/api/admin/audit", async () => {
    const parsed = auditQuerySchema.safeParse(
      searchParamsToObject(request.nextUrl.searchParams),
    );
    if (!parsed.success) return invalidBody(parsed.error.issues[0]?.message);

    return ok(await listAuditEvents(parsed.data));
  });
}
