import type { ZodType } from "zod";
import type { ParsedInput } from "../route-helpers";
import { REMOVED_LIMITS_MESSAGE, REMOVED_LIMIT_KEYS } from "@/lib/validation/bas-reports";

/**
 * The `parse` hook every Reports route hands to `withBas`: the JSON body
 * through one Zod schema, the first issue's message as the 422. One helper so
 * the routes cannot each read the body a little differently.
 *
 * It is a hook, not a call: `withBas` runs it AFTER the grant check, so an
 * unauthenticated caller never learns what a valid body looks like.
 *
 * `removedKeys` (2026-11-12): keys the API used to take and now refuses
 * with 400 `limits_removed` and a sentence saying where the setting went -
 * before the schema, which would otherwise report them as merely
 * unrecognised. An old build of the editor fails loudly rather than having
 * its limits dropped on the floor.
 */
export function parseBody<T>(
  request: Request,
  schema: ZodType<T>,
  options: { removedKeys?: readonly string[]; removedMessage?: string } = {},
): () => Promise<ParsedInput<T>> {
  return async () => {
    const body: unknown = await request.json().catch(() => null);
    if (options.removedKeys !== undefined && body !== null && typeof body === "object") {
      const sent = options.removedKeys.filter((key) => Object.prototype.hasOwnProperty.call(body, key));
      if (sent.length > 0) {
        return { ok: false, status: 400, code: "limits_removed", message: options.removedMessage ?? REMOVED_LIMITS_MESSAGE };
      }
    }
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      return { ok: false, message: parsed.error.issues[0]?.message };
    }
    return { ok: true, data: parsed.data };
  };
}

/** The create and update bodies, with the two removed limit keys refused by name. */
export function parseReportBody<T>(request: Request, schema: ZodType<T>): () => Promise<ParsedInput<T>> {
  return parseBody(request, schema, { removedKeys: REMOVED_LIMIT_KEYS });
}
