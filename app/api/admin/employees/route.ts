import type { NextRequest } from "next/server";
import { ok } from "@/lib/api/response";
import { invalidBody, withAdmin } from "@/lib/admin/route-helpers";
import { listEmployees } from "@/lib/admin/service";
import {
  employeeListQuerySchema,
  searchParamsToObject,
} from "@/lib/validation/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// There is deliberately no POST here. Admins grant access; they do not create
// accounts. Employees exist because they signed in.
export async function GET(request: NextRequest) {
  return withAdmin("/api/admin/employees", async () => {
    const parsed = employeeListQuerySchema.safeParse(
      searchParamsToObject(request.nextUrl.searchParams),
    );
    if (!parsed.success) {
      return invalidBody(parsed.error.issues[0]?.message);
    }

    return ok(await listEmployees(parsed.data));
  });
}
