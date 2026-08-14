import type { NextRequest } from "next/server";
import { ok } from "@/lib/api/response";
import { invalidBody, withAdmin } from "@/lib/admin/route-helpers";
import { createPosition, listPositions } from "@/lib/admin/service";
import { listItemCreateSchema } from "@/lib/validation/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  return withAdmin("/api/admin/positions", async () => {
    const includeHidden =
      request.nextUrl.searchParams.get("includeHidden") === "true";
    return ok(await listPositions(includeHidden));
  });
}

export async function POST(request: Request) {
  return withAdmin("/api/admin/positions", async (viewer) => {
    const body: unknown = await request.json().catch(() => null);
    const parsed = listItemCreateSchema.safeParse(body);
    if (!parsed.success) return invalidBody(parsed.error.issues[0]?.message);

    return ok(await createPosition(viewer.id, parsed.data.name), 201);
  });
}
