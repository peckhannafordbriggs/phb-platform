import { ok, withBasSettings } from "@/lib/modules/bas/route-helpers";
import { settingsResult } from "@/lib/modules/bas/settings-http";
import { createBasProject } from "@/lib/modules/bas/settings-service";
import {
  createProjectSchema,
  type CreateProjectInput,
} from "@/lib/validation/bas-settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ROUTE = "/api/modules/bas/settings/projects";

/**
 * Create a project.
 *
 * `withBasSettings`, so a BAS user without the module-admin flag gets 404 - the
 * same answer the read route gives, and for the same reason. A write route
 * answering 403 would confirm the surface exists to exactly the person the GET
 * is hiding it from, which would make the pair of them pointless.
 */
export async function POST(request: Request) {
  return withBasSettings(
    ROUTE,
    async (viewer, input: CreateProjectInput) =>
      settingsResult(
        () => createBasProject(viewer, input),
        (created) => ok(created, 201),
      ),
    async () => {
      const body: unknown = await request.json().catch(() => null);
      const parsed = createProjectSchema.safeParse(body);
      if (!parsed.success) {
        return { ok: false, message: parsed.error.issues[0]?.message };
      }
      return { ok: true, data: parsed.data };
    },
  );
}
