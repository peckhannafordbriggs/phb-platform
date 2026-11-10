// Relative, not "@/...": prisma/seed.ts runs under tsx, and prisma/bas-vocabularies.ts
// imports the generated client the same way for the same reason.
import type { Prisma, PrismaClient } from "../lib/generated/prisma/client";
import { BAS_LIBRARY_QUESTIONS } from "../lib/modules/bas/reports/library";

/**
 * The shared report-question library, installed by the seed (Reports, Phase 1).
 *
 * Reference data, like the vocabularies beside it, and subject to the same
 * rule as a module row (docs/10-adding-a-module.md): the seed reaches every
 * fresh database and never production, so the add_bas_reports migration
 * carries the identical twenty rows with ON CONFLICT (key) DO NOTHING.
 * tests/bas-reports-library.test.ts holds the migration's block to the
 * TypeScript list.
 *
 * Upserts text and metadata so a correction in library.ts reaches every
 * database the seed runs on. NEVER writes `enabled`: a module admin who
 * turned a question off must not have it turned back on by the next deploy -
 * the same reason the module seed never writes `status`.
 */

type DbClient = PrismaClient | Prisma.TransactionClient;

export interface BasReportLibrarySeedResult {
  questions: number;
  /** Computed rows in the table that this repository does not declare. */
  undeclared: string[];
}

export async function seedBasReportLibrary(
  client: DbClient,
): Promise<BasReportLibrarySeedResult> {
  for (const q of BAS_LIBRARY_QUESTIONS) {
    const fields = {
      section: q.section,
      position: q.position,
      text: q.text,
      kind: q.kind,
      analysisFn: q.analysisFn,
      appliesToLabel: q.appliesToLabel,
      appliesToEquipment: q.appliesToEquipment,
      requiredRoles: q.requiredRoles as unknown as Prisma.InputJsonValue,
      minCoverage: q.minCoverage,
    };
    await client.basLibraryQuestion.upsert({
      where: { key: q.key },
      update: fields,
      create: { key: q.key, ...fields },
    });
  }

  const declared = new Set(BAS_LIBRARY_QUESTIONS.map((q) => q.key));
  const present = await client.basLibraryQuestion.findMany({
    where: { kind: "computed" },
    select: { key: true },
  });
  const undeclared = present
    .map((r) => r.key)
    .filter((key) => !declared.has(key))
    .sort();

  return { questions: BAS_LIBRARY_QUESTIONS.length, undeclared };
}
