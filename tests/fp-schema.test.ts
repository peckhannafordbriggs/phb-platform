import { afterAll, describe, expect, it } from "vitest";
import {
  COIL_VALUES,
  CONFIRMED_WITH_VALUES,
  EXPOSURE_VALUES,
  PROTECTION_VALUES,
  STATUS_VALUES,
} from "@/lib/modules/freeze-protection/vocab";
import { disconnectDb, testDb } from "./db";

/**
 * The CHECK constraints in add_fp_tables hold the same closed vocabularies as
 * lib/modules/freeze-protection/vocab.ts. Read back out of the catalog, so a
 * value added on one side only fails here instead of as a 500 in the field.
 */

afterAll(disconnectDb);

async function checkValues(constraint: string): Promise<string[]> {
  const rows = await testDb.$queryRawUnsafe<{ def: string }[]>(
    `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = $1`,
    constraint,
  );
  expect(rows, constraint).toHaveLength(1);
  return [...rows[0]!.def.matchAll(/'([a-z_]+)'::text/g)].map((m) => m[1]!).sort();
}

describe("closed vocabularies agree with the database", () => {
  it.each([
    ["fp_results_status_check", STATUS_VALUES],
    ["fp_equipment_coil_check", COIL_VALUES],
    ["fp_results_exposure_check", EXPOSURE_VALUES],
    ["fp_results_protection_check", PROTECTION_VALUES],
    ["fp_results_documented_with_check", CONFIRMED_WITH_VALUES],
  ] as const)("%s", async (constraint, values) => {
    expect(await checkValues(constraint)).toEqual([...values].sort());
  });
});
