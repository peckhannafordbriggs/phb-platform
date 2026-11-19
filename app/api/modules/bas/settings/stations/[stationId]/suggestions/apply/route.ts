import { ok, withBasSettings } from "@/lib/modules/bas/route-helpers";
import { settingsResult } from "@/lib/modules/bas/settings-http";
import { applyHighConfidenceSuggestions } from "@/lib/modules/bas/settings-service";
import {
  applySuggestionsSchema,
  type ApplySuggestionsInput,
} from "@/lib/validation/bas-settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ROUTE = "/api/modules/bas/settings/stations/[stationId]/suggestions/apply";

/**
 * "Apply all high-confidence suggestions", confirmed (2026-11-19).
 *
 * WHAT IT ACCEPTS. `{ pointIds }` - the points the preview showed and the
 * person kept, and nothing else. Not a role, not an equipment: the service
 * computes each point's suggestion again and applies that, so this route
 * cannot write a role the name patterns did not suggest.
 *
 * WHAT HAPPENS ON FAILURE. Nothing. A point not on this station is 404
 * `point_not_found`; a point whose suggestion is gone or is no longer
 * high-confidence is 409 `preview_stale`. One transaction; every half is
 * written only where it is still empty, so a point classified since the
 * preview is left alone and counted unchanged.
 *
 * WHAT COMES BACK. `{ points, roleChanged, equipmentChanged, unchanged,
 * equipmentCreated }`.
 *
 * Audited as one `bas.suggestions_applied` row for the action, and the usual
 * row per point per half carrying `source: "suggestions"`. Module admins
 * only, like every settings route.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ stationId: string }> },
) {
  return withBasSettings(
    ROUTE,
    async (viewer, input: ApplySuggestionsInput) => {
      const { stationId } = await params;
      return settingsResult(
        () => applyHighConfidenceSuggestions(viewer, stationId, input),
        (result) => ok(result),
      );
    },
    async () => {
      const body: unknown = await request.json().catch(() => null);
      const parsed = applySuggestionsSchema.safeParse(body);
      if (!parsed.success) {
        return { ok: false, message: parsed.error.issues[0]?.message };
      }
      return { ok: true, data: parsed.data };
    },
  );
}
