import { notFound, ok } from "@/lib/api/response";
import { withAdmin } from "@/lib/admin/route-helpers";
import { getEmployeeDetail } from "@/lib/admin/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return withAdmin("/api/admin/employees/[id]", async () => {
    const { id } = await params;
    const employee = await getEmployeeDetail(id);

    if (employee === null) return notFound("Employee not found.");
    return ok(employee);
  });
}
