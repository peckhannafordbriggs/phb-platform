import { z } from "zod";
import { fail } from "@/lib/api/response";
import { BasError } from "@/lib/modules/bas/errors";
import { MAX_WINDOW_DAYS, MIN_WINDOW_DAYS, DEFAULT_WINDOW_DAYS, parsePointId } from "@/lib/modules/bas/service";
import { ok, withBas } from "@/lib/modules/bas/route-helpers";
import { summariseTrend, type TrendSummaryRequest } from "@/lib/modules/bas/trend-summary/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ROUTE = "/api/modules/bas/point-explorer/summary";
const CALENDAR_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * "Explain this trend" (2026-11-20): the point and range on screen, and
 * whether to write a new summary even when one is cached for the same data.
 *
 * Module access, nothing more - the page's own guard, through `withBas`. A
 * POST, because a cache miss spends money and writes a row; a GET that did
 * either would be prefetched by somebody's browser.
 */
const BodySchema = z
  .object({
    point: z.string().trim().min(1).max(32),
    days: z.number().int().min(MIN_WINDOW_DAYS).max(MAX_WINDOW_DAYS).default(DEFAULT_WINDOW_DAYS),
    from: z.string().trim().regex(CALENDAR_DATE).optional(),
    to: z.string().trim().regex(CALENDAR_DATE).optional(),
    refresh: z.boolean().default(false),
  })
  .strict()
  .refine((b) => (b.from === undefined) === (b.to === undefined), {
    message: "from and to must be given together",
  });

export async function POST(request: Request) {
  return withBas(
    ROUTE,
    async (viewer, input: TrendSummaryRequest) => {
      try {
        return ok(await summariseTrend(viewer, input));
      } catch (error) {
        if (error instanceof BasError && (error.code === "point_not_found" || error.code === "site_not_found")) {
          return fail(404, "not_found", error.message);
        }
        if (error instanceof BasError && error.code === "invalid_range") {
          return fail(422, "validation_failed", error.message);
        }
        throw error;
      }
    },
    async () => {
      const body: unknown = await request.json().catch(() => null);
      const parsed = BodySchema.safeParse(body);
      if (!parsed.success) {
        return { ok: false, message: parsed.error.issues[0]?.message ?? "The request is not valid." };
      }
      let pointId: bigint | null;
      try {
        pointId = parsePointId(parsed.data.point);
      } catch {
        return { ok: false, message: "point must be a point id." };
      }
      if (pointId === null) return { ok: false, message: "point must be a point id." };
      return {
        ok: true,
        data: {
          pointId,
          windowDays: parsed.data.days,
          range:
            parsed.data.from !== undefined && parsed.data.to !== undefined
              ? { from: parsed.data.from, to: parsed.data.to }
              : null,
          refresh: parsed.data.refresh,
        },
      };
    },
  );
}
