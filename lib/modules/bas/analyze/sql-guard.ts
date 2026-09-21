/**
 * The SQL guard: the third of three barriers between the model and a write.
 *
 * The first two are the database's - a role with no write grant, and a
 * transaction opened READ ONLY (see pool.ts). Either alone stops a write. This
 * one exists so that a write is refused BEFORE it reaches the database, with a
 * reason a person can read, and so that "a second statement" and "a CTE that
 * writes" are rejected as such rather than surfacing as a permission error the
 * screen has to interpret.
 *
 * It is a tokenizer, not a regex. docs/BAS-B5.md asks for a parse where the
 * parse is cheap, and this is the cheap one: it understands string literals,
 * quoted identifiers, dollar-quoted strings, both comment styles and E'' escapes
 * well enough that a keyword inside any of them is not a keyword. What it does
 * NOT do is understand SQL grammar - it does not know that `UPDATE` in
 * `SELECT ... FOR UPDATE` is a lock rather than a write. It does not need to:
 * a token from the refused list anywhere outside a literal is a refusal,
 * whatever the grammar around it, because no read-only question needs any of
 * them.
 *
 * Deliberately no allowlist of table names. Which tables the role may read is
 * the role's decision, made in role.ts and enforced by PostgreSQL; a second
 * copy of that list here would be one more thing to keep in step, and a
 * refusal from the database is already an honest answer.
 */

export type GuardVerdict =
  | { ok: true; sql: string }
  | { ok: false; reason: string };

/**
 * Tokens that mean "this is not a read", wherever they appear.
 *
 * Grouped by why. Every one is refused as a bare word outside a literal.
 */
const REFUSED_KEYWORDS: ReadonlySet<string> = new Set([
  // Writes.
  "INSERT", "UPDATE", "DELETE", "MERGE", "TRUNCATE", "UPSERT",
  // DDL.
  "CREATE", "ALTER", "DROP", "RENAME", "COMMENT", "REINDEX", "CLUSTER", "REFRESH",
  // Privileges and roles.
  "GRANT", "REVOKE", "REASSIGN", "OWNED",
  // Session and transaction control. Our own wrapper issues these; the model's
  // text may not, or it could turn read-only off or end the transaction. `END`
  // is deliberately NOT here: it closes every CASE expression, and the
  // transaction-ending form is caught anyway by the single-statement rule and
  // the extended protocol (pool.ts).
  "SET", "RESET", "BEGIN", "START", "COMMIT", "ROLLBACK", "ABORT",
  "SAVEPOINT", "RELEASE", "PREPARE", "DEALLOCATE", "DISCARD",
  // Procedures, bulk paths and side effects.
  "CALL", "DO", "COPY", "EXECUTE", "VACUUM", "ANALYZE", "ANALYSE", "LOCK",
  "LISTEN", "NOTIFY", "UNLISTEN", "LOAD", "SECURITY", "IMPORT",
  // SELECT INTO creates a table; FOR SHARE / FOR KEY SHARE take row locks.
  "INTO", "SHARE",
  // Cursors: the wrapper declares one; the model's text must not.
  "DECLARE", "FETCH", "MOVE", "CLOSE",
  // Introspection that says nothing about buildings and can be slow.
  "EXPLAIN", "SHOW",
]);

/** Functions that read the server rather than the data. Refused by name. */
const REFUSED_FUNCTIONS: ReadonlySet<string> = new Set([
  "PG_READ_FILE", "PG_READ_BINARY_FILE", "PG_LS_DIR", "PG_STAT_FILE",
  "LO_IMPORT", "LO_EXPORT", "DBLINK", "DBLINK_CONNECT", "PG_TERMINATE_BACKEND",
  "PG_CANCEL_BACKEND", "PG_RELOAD_CONF", "PG_ROTATE_LOGFILE", "SET_CONFIG",
  "PG_ADVISORY_LOCK", "PG_ADVISORY_XACT_LOCK", "PG_TRY_ADVISORY_LOCK",
  "PG_SLEEP", "PG_SLEEP_FOR", "PG_SLEEP_UNTIL",
]);

type Token =
  | { type: "word"; value: string }
  | { type: "semicolon" }
  | { type: "other" };

/**
 * Splits SQL into the tokens the guard cares about: bare words, semicolons and
 * "something else". Everything inside a literal or a comment is swallowed.
 *
 * Returns null when a literal or comment is never closed - a query like that
 * is not one PostgreSQL would run either, and refusing it here keeps the error
 * legible.
 */
export function tokenize(sql: string): Token[] | null {
  const tokens: Token[] = [];
  const n = sql.length;
  let i = 0;

  while (i < n) {
    const ch = sql[i]!;
    const next = sql[i + 1];

    // -- line comment
    if (ch === "-" && next === "-") {
      const end = sql.indexOf("\n", i);
      i = end === -1 ? n : end + 1;
      continue;
    }

    // /* block comment */ - PostgreSQL nests these, so depth is tracked.
    if (ch === "/" && next === "*") {
      let depth = 0;
      let j = i;
      while (j < n) {
        if (sql[j] === "/" && sql[j + 1] === "*") {
          depth += 1;
          j += 2;
        } else if (sql[j] === "*" && sql[j + 1] === "/") {
          depth -= 1;
          j += 2;
          if (depth === 0) break;
        } else {
          j += 1;
        }
      }
      if (depth !== 0) return null;
      i = j;
      continue;
    }

    // 'string' with '' doubling; E'string' with backslash escapes.
    if (ch === "'" || ((ch === "E" || ch === "e") && next === "'")) {
      let j = ch === "'" ? i + 1 : i + 2;
      const escaped = ch !== "'";
      let closed = false;
      while (j < n) {
        const c = sql[j]!;
        if (escaped && c === "\\") {
          j += 2;
          continue;
        }
        if (c === "'") {
          if (sql[j + 1] === "'") {
            j += 2;
            continue;
          }
          closed = true;
          j += 1;
          break;
        }
        j += 1;
      }
      if (!closed) return null;
      tokens.push({ type: "other" });
      i = j;
      continue;
    }

    // "quoted identifier" with "" doubling.
    if (ch === '"') {
      let j = i + 1;
      let closed = false;
      while (j < n) {
        if (sql[j] === '"') {
          if (sql[j + 1] === '"') {
            j += 2;
            continue;
          }
          closed = true;
          j += 1;
          break;
        }
        j += 1;
      }
      if (!closed) return null;
      // An identifier is a name, not a keyword, however it is spelled.
      tokens.push({ type: "other" });
      i = j;
      continue;
    }

    // $tag$ dollar-quoted string $tag$ (and the bare $$ form).
    if (ch === "$") {
      const tagMatch = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i));
      if (tagMatch !== null) {
        const opener = tagMatch[0];
        const close = sql.indexOf(opener, i + opener.length);
        if (close === -1) return null;
        tokens.push({ type: "other" });
        i = close + opener.length;
        continue;
      }
      // A positional parameter like $1 - refused later as "other" is harmless;
      // the model has no way to bind one anyway.
      tokens.push({ type: "other" });
      i += 1;
      continue;
    }

    if (ch === ";") {
      tokens.push({ type: "semicolon" });
      i += 1;
      continue;
    }

    // A bare word: keyword, function name or unquoted identifier.
    if (/[A-Za-z_]/.test(ch)) {
      let j = i + 1;
      while (j < n && /[A-Za-z0-9_$]/.test(sql[j]!)) j += 1;
      tokens.push({ type: "word", value: sql.slice(i, j).toUpperCase() });
      i = j;
      continue;
    }

    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }

    tokens.push({ type: "other" });
    i += 1;
  }

  return tokens;
}

/**
 * Accepts exactly one SELECT (or WITH ... SELECT) and nothing else.
 *
 * A single trailing semicolon is tolerated and removed, because models write
 * them and it carries no second statement. A semicolon followed by anything -
 * even a comment - is refused, because the tokenizer cannot tell a comment
 * that hides a statement from one that does not, and does not try.
 *
 * The returned `sql` is what the caller runs: trimmed, trailing semicolon gone.
 */
export function guardSql(raw: string): GuardVerdict {
  const sql = raw.trim();

  if (sql.length === 0) {
    return { ok: false, reason: "The query is empty." };
  }

  const tokens = tokenize(sql);
  if (tokens === null) {
    return {
      ok: false,
      reason: "The query has an unterminated string, identifier or comment.",
    };
  }

  // Statement count. A trailing semicolon is a single statement.
  const semicolons = tokens
    .map((token, index) => (token.type === "semicolon" ? index : -1))
    .filter((index) => index !== -1);

  if (semicolons.length > 1) {
    return { ok: false, reason: "Only one statement is allowed." };
  }
  // One semicolon is tolerated only as the LAST CHARACTER. Checked on the
  // text, not the token stream: the tokenizer swallows comments, so a
  // "SELECT 1; -- anything" would otherwise look like a trailing semicolon,
  // and the guard does not try to prove a comment is only a comment.
  if (
    semicolons.length === 1 &&
    (semicolons[0] !== tokens.length - 1 || !sql.endsWith(";"))
  ) {
    return {
      ok: false,
      reason: "Only one statement is allowed. Something follows the semicolon.",
    };
  }

  const words = tokens.filter(
    (token): token is Extract<Token, { type: "word" }> => token.type === "word",
  );

  const first = words[0]?.value;
  if (first !== "SELECT" && first !== "WITH") {
    return {
      ok: false,
      reason: `Only a SELECT is allowed. This starts with ${first ?? "something that is not a word"}.`,
    };
  }

  // A CTE that writes - WITH x AS (DELETE ...) - is caught here, as is every
  // other write, because the words are refused wherever they appear.
  for (const word of words) {
    if (REFUSED_KEYWORDS.has(word.value)) {
      return {
        ok: false,
        reason: `The query contains ${word.value}, which is not part of a read.`,
      };
    }
    if (REFUSED_FUNCTIONS.has(word.value)) {
      return {
        ok: false,
        reason: `The query calls ${word.value.toLowerCase()}(), which reads the server rather than the data.`,
      };
    }
  }

  const trimmed = sql.endsWith(";") ? sql.slice(0, -1).trimEnd() : sql;
  return { ok: true, sql: trimmed };
}

/**
 * Does this SQL read the readings? Decides whether gap overlap is even a
 * question, and whether a plan that names no points must be widened to every
 * point rather than left with no gap figure at all (see Provenance.scope).
 *
 * Token-based, so a comment saying "not bas_readings" does not count and a
 * quoted "bas_readings" does not either - the role would refuse a name spelled
 * that way anyway, since the tables are lower-case.
 */
export function readsReadings(sql: string): boolean {
  const tokens = tokenize(sql) ?? [];
  return tokens.some(
    (token) =>
      token.type === "word" &&
      (token.value === "BAS_READINGS" || token.value === "BAS_V_READING"),
  );
}
