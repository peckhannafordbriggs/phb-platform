import type { Prisma } from "@/lib/generated/prisma/client";
import { prisma } from "@/lib/db";
import { DEFAULT_SAFETY_CEILING, SETTINGS_ROW_ID, type SafetyCeilingView } from "./ceiling";

/**
 * The read half of the safety ceiling (ceiling.ts has the shape and the
 * defaults). Server only: imported by the engine, the queue, the Usage
 * service and the admin write. It is in the worker job's import graph, so
 * it imports prisma and nothing that boots the web app's environment
 * (tests/bas-reports-jobs-env.test.ts).
 *
 * The row can be absent: the migration inserts it, but the test suite
 * truncates employees CASCADE and the foreign key takes the row with it. A
 * missing row reads as the defaults, and the first admin edit upserts it,
 * so neither the engine nor the Usage page ever fails on an empty table.
 */

type Db = Prisma.TransactionClient | typeof prisma;

/** The ceiling in force, as the engine and the Usage page read it. */
export async function readSafetyCeiling(db: Db = prisma): Promise<SafetyCeilingView> {
  const row = await db.basReportSettings.findUnique({
    where: { settingsId: SETTINGS_ROW_ID },
    include: { updatedBy: { select: { email: true } } },
  });
  if (row === null) {
    return { ...DEFAULT_SAFETY_CEILING, updatedAt: null, updatedBy: null };
  }
  return {
    usd: Number(row.ceilingUsd),
    minutes: row.ceilingMinutes,
    updatedAt: row.updatedAt.toISOString(),
    updatedBy: row.updatedBy?.email ?? null,
  };
}
