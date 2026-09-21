import {
  Pool,
  type PoolClient,
  type QueryArrayConfig,
  type QueryConfig,
  type QueryResultRow,
} from "pg";
import type { Cell, ResultTable } from "./types";

/**
 * The Analyze tab's own connection pool - `pg` directly, NOT the Prisma
 * client.
 *
 * docs/08 is explicit: "its own connection pool, not the Prisma client, which
 * has write access because the rest of the platform needs it". Prisma connects
 * as the platform's owner role. This pool connects as `bas_analyze`, whose
 * grants are the boundary (role.ts). The two never share a connection.
 *
 * `timezone=UTC` for the same reason lib/db/adapter.ts pins it: a timestamptz
 * rendered under a session zone of America/New_York would reach the browser
 * with a different wall clock from every other BAS screen.
 */

/** `queryMode` is real in pg 8.23 and absent from @types/pg. */
type ExtendedQuery = QueryConfig & { queryMode: "extended" };

let pool: Pool | null = null;
let poolUrl: string | null = null;

export function getAnalyzePool(connectionString: string): Pool {
  if (pool !== null && poolUrl === connectionString) return pool;
  if (pool !== null) void pool.end().catch(() => undefined);

  pool = new Pool({
    connectionString,
    // Two connections. One question is one connection for a few seconds, and
    // the collector writes to this database every fifteen minutes - the pool
    // must never be what starves it.
    max: 2,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    // Applied per connection at startup. read_only here is the role default
    // restated; BEGIN READ ONLY below is what actually holds.
    options: "-c timezone=UTC -c default_transaction_read_only=on",
  });
  // A pool with no error listener turns an idle connection error into an
  // uncaught exception that takes the process down.
  pool.on("error", () => undefined);
  poolUrl = connectionString;
  return pool;
}

/** Test-only. Closes the pool so a test can point the next call elsewhere. */
export async function resetAnalyzePool(): Promise<void> {
  const current = pool;
  pool = null;
  poolUrl = null;
  if (current !== null) await current.end().catch(() => undefined);
}

export interface RunOptions {
  /** Per-statement ceiling for the model's query. Milliseconds. */
  statementTimeoutMs: number;
  /** Rows returned at most. One more is fetched to detect truncation. */
  rowCap: number;
}

/** The two we set. The role's own defaults are longer, as a backstop. */
export const DEFAULT_RUN_OPTIONS: RunOptions = {
  statementTimeoutMs: 15_000,
  rowCap: 200,
};

/**
 * A failure from running the model's SQL, with the database's own message.
 *
 * `code` is PostgreSQL's SQLSTATE where there is one:
 *   57014  statement_timeout - "the query took too long"
 *   42501  insufficient_privilege - the role refused it
 *   42P01  undefined_table, 42703 undefined_column, 42601 syntax_error
 * `timedOut` is derived so a caller does not have to know the number.
 */
export class QueryFailure extends Error {
  readonly code: string | null;
  readonly timedOut: boolean;

  constructor(message: string, code: string | null) {
    super(message);
    this.name = "QueryFailure";
    this.code = code;
    this.timedOut = code === "57014";
  }
}

/**
 * Runs ONE guarded SELECT and returns at most `rowCap` rows.
 *
 * The shape of this function is most of the safety model, so each line has a
 * reason:
 *
 *   BEGIN READ ONLY     the second barrier. `INSERT` inside is "cannot execute
 *                       INSERT in a read-only transaction" even on a role that
 *                       could write - which this one cannot.
 *   SET LOCAL timeout   ours, shorter than the role's 30s default. LOCAL, so
 *                       it dies with the transaction.
 *   DECLARE ... CURSOR  the model's SQL becomes the body of a cursor. A cursor
 *                       body must be a single SELECT (or VALUES) - PostgreSQL
 *                       refuses anything else at parse time - and FETCH n
 *                       enforces the row cap without rewriting the model's
 *                       query, so what ran is byte-for-byte what is shown.
 *   { text, values: [] } the extended protocol. With a parameter array, even
 *                       an empty one, `pg` sends a Parse message, and
 *                       PostgreSQL rejects a string holding two statements
 *                       ("cannot insert multiple commands into a prepared
 *                       statement"). So if the tokenizer in sql-guard.ts ever
 *                       missed a semicolon, the protocol catches it.
 *   ROLLBACK, always    nothing here has anything to commit.
 *
 * Cells are flattened to JSON-safe values at this boundary: `bigint` and
 * `numeric` arrive from `pg` as strings and stay strings (a numeric rounded to
 * a JS double would be a reading changed on its way to the screen), dates
 * become ISO 8601 UTC, and anything structured is stringified.
 */
export async function runGuardedSelect(
  pool: Pool,
  sql: string,
  options: RunOptions = DEFAULT_RUN_OPTIONS,
): Promise<ResultTable & { durationMs: number }> {
  const started = Date.now();
  const client = await pool.connect();

  try {
    await client.query("BEGIN READ ONLY");
    // An integer we formatted, not a value from anywhere else.
    await client.query(
      `SET LOCAL statement_timeout = ${Math.max(1, Math.floor(options.statementTimeoutMs))}`,
    );
    // `queryMode: "extended"` is what forces the Parse message. An empty
    // `values` array does NOT - node-postgres falls back to the simple
    // protocol when there is nothing to bind, and the simple protocol runs
    // "DECLARE ... FOR SELECT 1; SELECT 2" as two statements. Found by the
    // test that tries exactly that; it passed the smuggled statement until
    // this line said extended. The option exists at runtime in pg 8.23 and is
    // missing from @types/pg, hence the typed extension.
    const declare: ExtendedQuery = {
      text: `DECLARE phb_analyze_cursor NO SCROLL CURSOR FOR ${sql}`,
      values: [],
      queryMode: "extended",
    };
    await client.query(declare);
    const fetchConfig: QueryArrayConfig & { queryMode: "extended" } = {
      text: `FETCH ${options.rowCap + 1} FROM phb_analyze_cursor`,
      values: [],
      rowMode: "array",
      queryMode: "extended",
    };
    const result = await client.query<unknown[]>(fetchConfig);

    const columns = result.fields.map((field) => field.name);
    const raw = result.rows;
    const truncated = raw.length > options.rowCap;
    const rows = (truncated ? raw.slice(0, options.rowCap) : raw).map((row) =>
      row.map(toCell),
    );

    return {
      columns,
      rows,
      rowCount: rows.length,
      truncated,
      rowCap: options.rowCap,
      durationMs: Date.now() - started,
    };
  } catch (error) {
    throw toQueryFailure(error);
  } finally {
    // ROLLBACK even after success: nothing was written and the cursor closes
    // with the transaction. Swallow a failure here - the connection is about
    // to be released and a broken one is discarded by the pool.
    await client.query("ROLLBACK").catch(() => undefined);
    client.release();
  }
}

/**
 * A single parameterised query on the analyze pool, for the provenance
 * queries we write ourselves. Same role, same READ ONLY transaction; the
 * difference is that these are OUR SQL with bound parameters.
 */
export async function queryAsAnalyzeRole<T extends QueryResultRow>(
  pool: Pool,
  text: string,
  values: unknown[],
): Promise<T[]> {
  const client: PoolClient = await pool.connect();
  try {
    await client.query("BEGIN READ ONLY");
    const result = await client.query<T>({ text, values });
    return result.rows;
  } catch (error) {
    throw toQueryFailure(error);
  } finally {
    await client.query("ROLLBACK").catch(() => undefined);
    client.release();
  }
}

function toQueryFailure(error: unknown): QueryFailure {
  if (error instanceof QueryFailure) return error;
  const code =
    typeof (error as { code?: unknown }).code === "string"
      ? ((error as { code: string }).code)
      : null;
  const message = error instanceof Error ? error.message : String(error);
  return new QueryFailure(message, code);
}

export function toCell(value: unknown): Cell {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }
  if (Buffer.isBuffer(value)) return `<${value.length} bytes>`;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
