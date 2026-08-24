import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { MOVES } from "@/scripts/bas-tables";
import {
  columnTypes,
  exactTextExpression,
  rowHashes,
  tableChecksum,
} from "@/scripts/bas-checksum";

/**
 * The content-comparison engine that scripts/bas-import.ts verifies itself with.
 *
 * It exists because the import used to verify by row count. On 21 August 2026
 * the same import was compared by content for the first time and turned out to
 * have truncated every microsecond timestamp to milliseconds and turned a jsonb
 * array into a jsonb object, in a run that reported IMPORT VERIFIED. Counts
 * matched exactly on both sides.
 *
 * So what these tests are really about is whether the comparison can FAIL. Each
 * one changes exactly one thing and asserts the checksum moves. A checksum that
 * cannot notice a difference is worse than no checksum, because it is reported
 * as a pass.
 *
 * Everything runs on a real PostgreSQL connection - the conversions are SQL
 * expressions, so there is nothing to test without a server. A raw `pg` client
 * rather than Prisma, because that is what the scripts use.
 */

const TABLE = "zztest_checksum";
let client: Client;

/** Every type the BAS schema actually uses, plus the ones a future column might. */
const CREATE = `
  CREATE TABLE ${TABLE} (
    id            bigint PRIMARY KEY,
    name          text,
    flag          boolean,
    count_i       integer,
    amount        double precision,
    small         real,
    doc           jsonb,
    at            timestamptz,
    plain         timestamp,
    day           date,
    exact         numeric(12, 4)
  )`;

/**
 * One row per awkward case. The values matter:
 *   - $-hex escapes, the shape a wrap or a re-encode mangles
 *   - the literal string 'null', which has been a real bug in bas_points.unit
 *   - the empty string next to a NULL, on the same column
 *   - microseconds, which JS Date cannot hold
 *   - a jsonb ARRAY, which node-postgres turns into a Postgres array literal
 */
const SEED = `
  INSERT INTO ${TABLE} VALUES
  (1, 'AHU$2d1$20Supply$20Air', true,  1, 64.61493682861328, 1.5,
      '[]'::jsonb, '2026-08-20 12:31:32.995363+00', '2026-08-20 12:31:32.995363',
      '2026-08-20', 1.2345),
  (2, 'null',                   false, 0, 0.1,              0,
      '{}'::jsonb, '2026-08-20 12:31:32.995000+00', '2026-08-20 12:31:32.995000',
      '2026-08-21', 0.0001),
  (3, '',                       NULL,  NULL, NULL,          NULL,
      NULL,        NULL,                            NULL,
      NULL,        NULL),
  (4, NULL,                     NULL,  NULL, NULL,          NULL,
      NULL,        NULL,                            NULL,
      NULL,        NULL)`;

async function checksum(): Promise<string> {
  const result = await tableChecksum(client, "public", TABLE, ["id"]);
  return result.checksum;
}

/** Applies a change, reads the checksum, and undoes the change. */
async function checksumAfter(sql: string, undo: string): Promise<string> {
  await client.query(sql);
  const value = await checksum();
  await client.query(undo);
  return value;
}

beforeAll(async () => {
  client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  // Everything happens inside one transaction that is never committed, so the
  // test database is untouched even if a test throws.
  await client.query("BEGIN");
  await client.query(CREATE);
  await client.query(SEED);
});

afterAll(async () => {
  await client.query("ROLLBACK").catch(() => undefined);
  await client.end();
});

describe("the checksum notices a change in every type", () => {
  it("is stable when nothing changes", async () => {
    const first = await checksum();
    const second = await checksum();

    expect(first).toBe(second);
    expect(first).toMatch(/^[0-9a-f]{32}$/);
  });

  it("notices one character in a text value", async () => {
    const baseline = await checksum();

    const changed = await checksumAfter(
      `UPDATE ${TABLE} SET name = 'AHU$2d1$20Supply$20air' WHERE id = 1`,
      `UPDATE ${TABLE} SET name = 'AHU$2d1$20Supply$20Air' WHERE id = 1`,
    );

    expect(changed).not.toBe(baseline);
    expect(await checksum()).toBe(baseline);
  });

  it("notices a $-hex escape being decoded", async () => {
    const baseline = await checksum();

    // The failure the runbook warns about: $20 decoded to a space produces an
    // oBIX URL that 404s exactly like a missing point.
    const changed = await checksumAfter(
      `UPDATE ${TABLE} SET name = 'AHU-1 Supply Air' WHERE id = 1`,
      `UPDATE ${TABLE} SET name = 'AHU$2d1$20Supply$20Air' WHERE id = 1`,
    );

    expect(changed).not.toBe(baseline);
  });

  it("notices one microsecond on a timestamptz", async () => {
    const baseline = await checksum();

    const changed = await checksumAfter(
      `UPDATE ${TABLE} SET at = at + interval '1 microsecond' WHERE id = 1`,
      `UPDATE ${TABLE} SET at = at - interval '1 microsecond' WHERE id = 1`,
    );

    expect(changed).not.toBe(baseline);
  });

  it("notices microseconds truncated to milliseconds - the actual import bug", async () => {
    const baseline = await checksum();

    const changed = await checksumAfter(
      `UPDATE ${TABLE} SET at = date_trunc('milliseconds', at) WHERE id = 1`,
      `UPDATE ${TABLE} SET at = '2026-08-20 12:31:32.995363+00' WHERE id = 1`,
    );

    expect(changed).not.toBe(baseline);
    expect(await checksum()).toBe(baseline);
  });

  it("notices a one-hour offset shift", async () => {
    const baseline = await checksum();

    const changed = await checksumAfter(
      `UPDATE ${TABLE} SET at = at + interval '1 hour' WHERE id = 1`,
      `UPDATE ${TABLE} SET at = at - interval '1 hour' WHERE id = 1`,
    );

    expect(changed).not.toBe(baseline);
  });

  it("notices one ULP in a double", async () => {
    const baseline = await checksum();

    // The smallest change a float8 can hold. A decimal rendering at low
    // precision would show the same string for both.
    const changed = await checksumAfter(
      `UPDATE ${TABLE} SET amount = amount * (1 + 2.220446049250313e-16) WHERE id = 1`,
      `UPDATE ${TABLE} SET amount = 64.61493682861328 WHERE id = 1`,
    );

    expect(changed).not.toBe(baseline);
    expect(await checksum()).toBe(baseline);
  });

  it("notices a jsonb array becoming a jsonb object - the other import bug", async () => {
    const baseline = await checksum();

    const changed = await checksumAfter(
      `UPDATE ${TABLE} SET doc = '{}'::jsonb WHERE id = 1`,
      `UPDATE ${TABLE} SET doc = '[]'::jsonb WHERE id = 1`,
    );

    expect(changed).not.toBe(baseline);
  });

  it("notices NULL becoming the empty string", async () => {
    const baseline = await checksum();

    // Row 4 has name NULL and row 3 has name ''. If the payload coalesced NULL
    // to '' these two rows would be indistinguishable.
    const changed = await checksumAfter(
      `UPDATE ${TABLE} SET name = '' WHERE id = 4`,
      `UPDATE ${TABLE} SET name = NULL WHERE id = 4`,
    );

    expect(changed).not.toBe(baseline);
  });

  it("notices the empty string becoming NULL", async () => {
    const baseline = await checksum();

    const changed = await checksumAfter(
      `UPDATE ${TABLE} SET name = NULL WHERE id = 3`,
      `UPDATE ${TABLE} SET name = '' WHERE id = 3`,
    );

    expect(changed).not.toBe(baseline);
  });

  it("notices a boolean flipping, an integer changing, and a numeric scale change", async () => {
    const baseline = await checksum();

    for (const [change, undo] of [
      [`UPDATE ${TABLE} SET flag = false WHERE id = 1`, `UPDATE ${TABLE} SET flag = true WHERE id = 1`],
      [`UPDATE ${TABLE} SET count_i = 2 WHERE id = 1`, `UPDATE ${TABLE} SET count_i = 1 WHERE id = 1`],
      [`UPDATE ${TABLE} SET exact = 1.2340 WHERE id = 1`, `UPDATE ${TABLE} SET exact = 1.2345 WHERE id = 1`],
      [`UPDATE ${TABLE} SET day = '2026-08-21' WHERE id = 1`, `UPDATE ${TABLE} SET day = '2026-08-20' WHERE id = 1`],
      [`UPDATE ${TABLE} SET small = 1.6 WHERE id = 1`, `UPDATE ${TABLE} SET small = 1.5 WHERE id = 1`],
      [`UPDATE ${TABLE} SET plain = plain + interval '1 microsecond' WHERE id = 1`,
       `UPDATE ${TABLE} SET plain = plain - interval '1 microsecond' WHERE id = 1`],
    ] as Array<[string, string]>) {
      expect(await checksumAfter(change, undo), change).not.toBe(baseline);
    }

    expect(await checksum()).toBe(baseline);
  });

  it("notices a row disappearing and a row appearing", async () => {
    const baseline = await checksum();

    const deleted = await checksumAfter(
      `DELETE FROM ${TABLE} WHERE id = 4`,
      `INSERT INTO ${TABLE} (id) VALUES (4)`,
    );
    expect(deleted).not.toBe(baseline);

    const added = await checksumAfter(
      `INSERT INTO ${TABLE} (id) VALUES (99)`,
      `DELETE FROM ${TABLE} WHERE id = 99`,
    );
    expect(added).not.toBe(baseline);

    expect(await checksum()).toBe(baseline);
  });

  it("notices two rows swapping their values", async () => {
    const baseline = await checksum();

    // Row count identical, and the multiset of values identical too. Only the
    // pairing of key to value changed, which is why the key has to be part of
    // what is ordered rather than just part of the payload.
    await client.query(
      `UPDATE ${TABLE} SET name = CASE id WHEN 1 THEN 'null' ELSE 'AHU$2d1$20Supply$20Air' END
        WHERE id IN (1, 2)`,
    );
    const swapped = await checksum();
    await client.query(
      `UPDATE ${TABLE} SET name = CASE id WHEN 1 THEN 'AHU$2d1$20Supply$20Air' ELSE 'null' END
        WHERE id IN (1, 2)`,
    );

    expect(swapped).not.toBe(baseline);
    expect(await checksum()).toBe(baseline);
  });
});

describe("the checksum does not move for things that are not differences", () => {
  it("is unaffected by extra_float_digits", async () => {
    const baseline = await checksum();

    // With this setting two different doubles both render as '6e+01' via ::text
    // and would compare equal. float8send does not go through the formatter.
    await client.query("SET LOCAL extra_float_digits = -15");
    const lowPrecision = await checksum();
    await client.query("SET LOCAL extra_float_digits = 3");
    const highPrecision = await checksum();
    await client.query("RESET extra_float_digits");

    expect(lowPrecision).toBe(baseline);
    expect(highPrecision).toBe(baseline);
  });

  it("is unaffected by the session TimeZone", async () => {
    const baseline = await checksum();

    // The comparison normalises to UTC, so two databases on different server
    // timezones agree. Without AT TIME ZONE 'UTC' this would differ.
    await client.query("SET LOCAL TimeZone = 'Asia/Kolkata'");
    const kolkata = await checksum();
    await client.query("SET LOCAL TimeZone = 'UTC'");
    const utc = await checksum();
    await client.query("RESET TimeZone");

    expect(kolkata).toBe(baseline);
    expect(utc).toBe(baseline);
  });

  it("is unaffected by DateStyle", async () => {
    const baseline = await checksum();

    await client.query("SET LOCAL DateStyle = 'German, DMY'");
    const german = await checksum();
    await client.query("RESET DateStyle");

    expect(german).toBe(baseline);
  });

  it("is unaffected by physical row order", async () => {
    const baseline = await checksum();

    // Rewrites every row, which changes their physical order in the heap. The
    // explicit ORDER BY is what makes this a no-op.
    await client.query(`UPDATE ${TABLE} SET count_i = count_i`);
    expect(await checksum()).toBe(baseline);
  });
});

describe("a comparison that cannot compare must fail, not pass", () => {
  it("refuses a type it has no exact rule for", async () => {
    // The rule that keeps the engine honest. A ::text fallback would make every
    // future type comparable-ish, which is how a check stops checking.
    expect(() => exactTextExpression({ name: "thing", type: "point" })).toThrow(
      /No exact-text rule for thing \(point\)/,
    );
    expect(() =>
      exactTextExpression({ name: "thing", type: "tsvector" }),
    ).toThrow(/No exact-text rule/);
  });

  it("refuses to checksum zero columns", async () => {
    // md5 of nothing is a perfectly stable value that matches on both sides
    // forever.
    await expect(
      tableChecksum(client, "public", TABLE, ["id"], []),
    ).rejects.toThrow(/INCONCLUSIVE/);
  });

  it("refuses a column that does not exist", async () => {
    await expect(
      tableChecksum(client, "public", TABLE, ["id"], ["nope"]),
    ).rejects.toThrow(/has no column nope/);
  });

  it("refuses a key column that does not exist", async () => {
    await expect(
      tableChecksum(client, "public", TABLE, ["nope"]),
    ).rejects.toThrow(/has no key column nope/);
  });

  it("refuses a table that does not exist", async () => {
    await expect(
      columnTypes(client, "public", "zztest_absent"),
    ).rejects.toThrow(/no columns, or does not exist/);
  });

  it("reports which columns it compared, so a caller can count them", async () => {
    const all = await tableChecksum(client, "public", TABLE, ["id"]);
    const some = await tableChecksum(client, "public", TABLE, ["id"], ["id", "name"]);

    expect(all.columnsCompared).toHaveLength(11);
    expect(some.columnsCompared).toEqual(["id", "name"]);
    // Different questions, so they must not accidentally agree.
    expect(some.checksum).not.toBe(all.checksum);
  });
});

describe("row hashes locate which row differs", () => {
  it("changes only the hash of the row that changed", async () => {
    const before = await rowHashes(client, "public", TABLE, ["id"]);

    await client.query(`UPDATE ${TABLE} SET count_i = 42 WHERE id = 1`);
    const after = await rowHashes(client, "public", TABLE, ["id"]);
    await client.query(`UPDATE ${TABLE} SET count_i = 1 WHERE id = 1`);

    expect(after.get("1")).not.toBe(before.get("1"));
    for (const key of ["2", "3", "4"]) {
      expect(after.get(key), `row ${key} must be untouched`).toBe(before.get(key));
    }
  });

  it("keys a NULL-valued key distinctly rather than dropping the row", async () => {
    const hashes = await rowHashes(client, "public", TABLE, ["id"]);

    expect([...hashes.keys()].sort()).toEqual(["1", "2", "3", "4"]);
  });
});

describe("the shared table list stays consistent with itself", () => {
  /**
   * No database involved. The import and the verifier both read this list, so an
   * inconsistency here silently narrows what gets checked.
   */
  it("gives every table a verify key drawn from its own copied columns", () => {
    for (const move of MOVES) {
      expect(move.verifyKey.length, `${move.target} needs a verify key`).toBeGreaterThan(0);
      for (const key of move.verifyKey) {
        expect(move.columns, `${move.target}.${key} must be a copied column`).toContain(key);
      }
    }
  });

  it("names every table exactly once", () => {
    expect(new Set(MOVES.map((m) => m.source)).size).toBe(MOVES.length);
    expect(new Set(MOVES.map((m) => m.target)).size).toBe(MOVES.length);
  });

  it("covers the twelve BAS tables", () => {
    expect(MOVES).toHaveLength(12);
    // 103 columns in total - the number the import prints, so a silent narrowing
    // of any column list shows up here too.
    expect(MOVES.reduce((n, m) => n + m.columns.length, 0)).toBe(103);
  });

  it("lists deferred and sequence columns that the table actually copies", () => {
    for (const move of MOVES) {
      for (const column of move.deferred ?? []) {
        expect(move.columns, `${move.target}.${column}`).toContain(column);
      }
      if (move.sequenceColumn !== undefined) {
        expect(move.columns, `${move.target}.${move.sequenceColumn}`).toContain(
          move.sequenceColumn,
        );
      }
      // A deferred column is written NULL on the first pass and patched by key
      // afterwards, so it needs a key to patch by.
      if ((move.deferred ?? []).length > 0) {
        expect(move.keyColumn, `${move.target} defers columns`).toBeDefined();
      }
    }
  });
});
