import type { ZodType } from "zod";
import type { ParsedInput } from "../route-helpers";

/**
 * The `parse` hook every Reports route hands to `withBas`: the JSON body
 * through one Zod schema, the first issue's message as the 422. One helper so
 * eleven routes cannot each read the body a little differently.
 *
 * It is a hook, not a call: `withBas` runs it AFTER the grant check, so an
 * unauthenticated caller never learns what a valid body looks like.
 */
export function parseBody<T>(request: Request, schema: ZodType<T>): () => Promise<ParsedInput<T>> {
  return async () => {
    const body: unknown = await request.json().catch(() => null);
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      return { ok: false, message: parsed.error.issues[0]?.message };
    }
    return { ok: true, data: parsed.data };
  };
}
