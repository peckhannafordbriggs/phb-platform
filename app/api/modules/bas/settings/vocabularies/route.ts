import { ok, withBasSettings } from "@/lib/modules/bas/route-helpers";
import { listBasVocabularies } from "@/lib/modules/bas/settings-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ROUTE = "/api/modules/bas/settings/vocabularies";

/**
 * The role and equipment-type vocabularies, for the pickers (B8.5).
 *
 * Read from the tables, so the picker offers exactly what the foreign keys
 * accept. Read-only: the vocabulary is seeded (prisma/bas-vocabularies.ts)
 * and is not editable from the UI - B8.5 is explicit about that, and a role
 * invented on a screen would be a role the pairing views have never heard of.
 *
 * `withBasSettings`: the pickers live on the Points list, which is a
 * module-admin screen, and a vocabulary is of no use to anyone who cannot
 * assign from it.
 */
export async function GET() {
  return withBasSettings(ROUTE, async () => ok(await listBasVocabularies()));
}
