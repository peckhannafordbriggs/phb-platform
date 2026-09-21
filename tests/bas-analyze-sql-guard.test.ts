import { describe, expect, it } from "vitest";
import {
  guardSql,
  readsReadings,
  tokenize,
} from "@/lib/modules/bas/analyze/sql-guard";

/**
 * The SQL guard - the third barrier, and the one that gives a reason.
 *
 * Pure, so no database. What is proved: exactly one SELECT gets through, and
 * every way of smuggling a second statement or a write past a regex does not
 * get past a tokenizer. The database's own refusals are proved separately in
 * tests/bas-analyze-role.test.ts; this file is about the guard saying WHY.
 */

function refused(sql: string): string {
  const verdict = guardSql(sql);
  if (verdict.ok) throw new Error(`expected refusal, got: ${verdict.sql}`);
  return verdict.reason;
}

function allowed(sql: string): string {
  const verdict = guardSql(sql);
  if (!verdict.ok) throw new Error(`expected allowed, got: ${verdict.reason}`);
  return verdict.sql;
}

describe("exactly one SELECT", () => {
  it("allows a plain SELECT and strips one trailing semicolon", () => {
    expect(allowed("SELECT count(*) FROM bas_points;")).toBe(
      "SELECT count(*) FROM bas_points",
    );
  });

  it("allows WITH ... SELECT", () => {
    expect(
      allowed("WITH recent AS (SELECT * FROM bas_readings) SELECT count(*) FROM recent"),
    ).toContain("WITH recent");
  });

  it("refuses two statements", () => {
    expect(refused("SELECT 1; SELECT 2")).toContain("Only one statement");
  });

  it("refuses a second statement hidden after the semicolon in a comment", () => {
    // The tokenizer cannot see inside a comment, so it does not try: anything
    // after a semicolon, even a comment, is a refusal.
    expect(refused("SELECT 1; -- DELETE FROM bas_orgs")).toContain("follows the semicolon");
  });

  it("refuses something that is not a SELECT", () => {
    expect(refused("DELETE FROM bas_orgs")).toContain("Only a SELECT");
    expect(refused("SHOW search_path")).toContain("Only a SELECT");
    expect(refused("")).toBe("The query is empty.");
  });
});

describe("writes, wherever they hide", () => {
  it("refuses a CTE that writes", () => {
    expect(
      refused("WITH d AS (DELETE FROM bas_orgs RETURNING 1) SELECT count(*) FROM d"),
    ).toContain("DELETE");
    expect(
      refused("WITH i AS (INSERT INTO bas_orgs (name) VALUES ('x') RETURNING org_id) SELECT * FROM i"),
    ).toContain("INSERT");
    expect(
      refused("WITH u AS (UPDATE bas_points SET is_active = false RETURNING 1) SELECT 1"),
    ).toContain("UPDATE");
  });

  it("refuses SELECT INTO, which creates a table", () => {
    expect(refused("SELECT * INTO bas_copy FROM bas_points")).toContain("INTO");
  });

  it("refuses row locks", () => {
    expect(refused("SELECT * FROM bas_points FOR UPDATE")).toContain("UPDATE");
    expect(refused("SELECT * FROM bas_points FOR SHARE")).toContain("SHARE");
  });

  it("refuses session and transaction control", () => {
    expect(refused("SET default_transaction_read_only = off")).toContain("Only a SELECT");
    expect(refused("SELECT set_config('x', 'y', false)")).toContain("set_config");
    expect(refused("SELECT 1 FROM bas_points WHERE 1 = 1 COMMIT")).toContain("COMMIT");
  });

  it("refuses server-reading functions by name", () => {
    expect(refused("SELECT pg_read_file('/etc/passwd')")).toContain("pg_read_file");
    expect(refused("SELECT pg_sleep(60)")).toContain("pg_sleep");
  });

  it("is case-insensitive", () => {
    expect(refused("select 1; delete from bas_orgs")).toContain("Only one statement");
    expect(refused("Select * From bas_points For Update")).toContain("UPDATE");
  });
});

describe("keywords inside literals are not keywords", () => {
  it("allows DELETE inside a string literal", () => {
    expect(allowed("SELECT 'DELETE FROM x; DROP TABLE y' AS note")).toContain("DELETE");
  });

  it("allows a semicolon inside a string literal", () => {
    expect(allowed("SELECT name FROM bas_sites WHERE name = 'a;b'")).toContain("a;b");
  });

  it("allows quoted identifiers spelled like keywords", () => {
    expect(allowed('SELECT "update" FROM bas_points')).toContain('"update"');
  });

  it("allows doubled quotes and E'' escapes", () => {
    expect(allowed("SELECT 'it''s; fine' AS s")).toContain("it''s");
    expect(allowed("SELECT E'a\\'b; DELETE' AS s")).toContain("DELETE");
  });

  it("allows dollar-quoted strings", () => {
    expect(allowed("SELECT $q$DELETE; DROP$q$ AS s")).toContain("$q$");
    expect(allowed("SELECT $$; INSERT$$ AS s")).toContain("$$");
  });

  it("swallows comments, including nested block comments", () => {
    expect(allowed("SELECT 1 -- INSERT INTO x\n FROM bas_points")).toContain("FROM bas_points");
    expect(allowed("SELECT /* outer /* DELETE */ still comment */ 1")).toBe(
      "SELECT /* outer /* DELETE */ still comment */ 1",
    );
  });

  it("refuses an unterminated literal or comment rather than guessing", () => {
    expect(refused("SELECT 'open")).toContain("unterminated");
    expect(refused("SELECT /* open")).toContain("unterminated");
    expect(refused("SELECT $q$ open")).toContain("unterminated");
  });
});

describe("real SQL a planner writes", () => {
  it("allows CASE ... END, which every classification query uses", () => {
    expect(
      allowed(
        "SELECT CASE WHEN value_num > 75 THEN 'warm' ELSE 'cool' END AS band, count(*) FROM bas_readings GROUP BY 1",
      ),
    ).toContain("END");
  });

  it("allows date_trunc buckets, casts, and window functions", () => {
    expect(
      allowed(
        `SELECT date_trunc('hour', r.ts) AS hour,
                avg(r.value_num)::numeric(10,2) AS avg_value,
                row_number() OVER (ORDER BY r.ts) AS n
           FROM bas_readings r
           JOIN bas_points p ON p.point_id = r.point_id
          WHERE r.ts >= now() - interval '7 days'
          GROUP BY 1 ORDER BY 1`,
      ),
    ).toContain("date_trunc");
  });

  it("allows an interval literal containing the word 'day'", () => {
    expect(allowed("SELECT now() - interval '1 day'")).toContain("interval");
  });
});

describe("readsReadings", () => {
  it("is true for bas_readings and the readings view, as tokens", () => {
    expect(readsReadings("SELECT count(*) FROM bas_readings")).toBe(true);
    expect(readsReadings("SELECT * FROM bas_v_reading LIMIT 1")).toBe(true);
    expect(readsReadings("select * from BAS_READINGS")).toBe(true);
  });

  it("is false for other tables, and for the name inside a string or comment", () => {
    expect(readsReadings("SELECT count(*) FROM bas_points")).toBe(false);
    expect(readsReadings("SELECT 'bas_readings' AS t FROM bas_points")).toBe(false);
    expect(readsReadings("SELECT 1 -- bas_readings\n FROM bas_points")).toBe(false);
  });
});

describe("tokenize", () => {
  it("returns words upper-cased with literals collapsed", () => {
    const tokens = tokenize("select 'x' from \"T\"")!;
    expect(tokens.map((t) => (t.type === "word" ? t.value : t.type))).toEqual([
      "SELECT",
      "other",
      "FROM",
      "other",
    ]);
  });
});
