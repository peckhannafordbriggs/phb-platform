import "./load-env";
import { randomBytes } from "node:crypto";
import { Client } from "pg";
import {
  ANALYZE_ROLE,
  analyzeRoleGateSql,
  analyzeRoleGrantStatements,
  analyzeRoleProofs,
} from "../lib/modules/bas/analyze/role";

/**
 * Creates or updates the `bas_analyze` role - the one the Analyze tab's SQL
 * runs as - and PROVES its boundary before printing the connection string.
 *
 *   npm run bas:analyze:role                 # generates a password
 *   npm run bas:analyze:role -- --password=… # rotates to the one given
 *
 * Connects as DATABASE_URL, which locally is the superuser and in Azure is the
 * server admin. Re-runnable: it is also how the password is rotated, and how
 * a new bas_* object is granted after a person has added it to the allowlist
 * in lib/modules/bas/analyze/role.ts - the gate refuses to run until they do.
 *
 * ORDER: gate, then role, then grants, then proofs. A run that fails the gate
 * changes nothing. A run that fails a proof has already granted - so it says
 * so, loudly, and exits non-zero, and the runbook says what to do.
 *
 * Prints the URL to set as BAS_ASK_DATABASE_URL. The password appears ONCE, on
 * the terminal, and nowhere else. It is not written to any file by this
 * script.
 */

function argValue(name: string): string | null {
  const prefix = `--${name}=`;
  const hit = process.argv.slice(2).find((arg) => arg.startsWith(prefix));
  return hit === undefined ? null : hit.slice(prefix.length);
}

async function main(): Promise<void> {
  const adminUrl = process.env.DATABASE_URL?.trim();
  if (adminUrl === undefined || adminUrl.length === 0) {
    throw new Error("DATABASE_URL is not set. This script connects as the database owner.");
  }

  const password = argValue("password") ?? randomBytes(24).toString("base64url");
  if (password.length < 16) {
    throw new Error("Refusing a password shorter than 16 characters.");
  }

  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();

  const target = new URL(adminUrl);
  const database = decodeURIComponent(target.pathname.replace(/^\//, ""));
  console.log(`Database: ${target.host}/${database}`);

  try {
    // 1. The gate. Raises with the list of unclassified objects if any.
    await admin.query(analyzeRoleGateSql());
    console.log("Gate passed: every bas_* object is either allowed or withheld.");

    // 2. The role. Password as a bound literal - never interpolated.
    const exists = await admin.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM pg_roles WHERE rolname = $1",
      [ANALYZE_ROLE],
    );
    const verb = exists.rows[0]?.n === "0" ? "CREATE" : "ALTER";
    // Role names and passwords cannot be bind parameters in CREATE/ALTER
    // ROLE, so the statement is BUILT by PostgreSQL's format() from bound
    // parameters - %I quotes the identifier, %L the literal - and then run.
    // The password never passes through JavaScript string escaping.
    const built = await admin.query<{ stmt: string }>(
      `SELECT format('%s ROLE %I WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS PASSWORD %L', $1::text, $2::text, $3::text) AS stmt`,
      [verb, ANALYZE_ROLE, password],
    );
    await admin.query(built.rows[0]!.stmt);
    console.log(`${verb === "CREATE" ? "Created" : "Updated"} role ${ANALYZE_ROLE}.`);

    // 3. Grants, revokes, role settings.
    const statements = analyzeRoleGrantStatements(ANALYZE_ROLE);
    for (const statement of statements) {
      await admin.query(statement);
    }
    console.log(`Applied ${statements.length} grant/revoke statements.`);
  } finally {
    await admin.end();
  }

  // 4. Prove it, AS THE ROLE, with read-only turned OFF so the grants are
  // what refuse the writes - runbook.md, *Two independent layers stop writes*.
  const roleUrl = new URL(adminUrl);
  roleUrl.username = ANALYZE_ROLE;
  roleUrl.password = password;
  roleUrl.search = "";

  const asRole = new Client({
    connectionString: roleUrl.toString(),
    options: "-c default_transaction_read_only=off",
  });
  await asRole.connect();

  let failures = 0;
  try {
    for (const proof of analyzeRoleProofs()) {
      let succeeded: boolean;
      let detail = "";
      try {
        await asRole.query(proof.sql);
        succeeded = true;
      } catch (error) {
        succeeded = false;
        detail = error instanceof Error ? error.message : String(error);
      }
      const pass = succeeded === proof.mustSucceed;
      if (!pass) failures += 1;
      console.log(
        `  ${pass ? "ok  " : "FAIL"}  ${proof.sql.padEnd(64)} ${proof.mustSucceed ? "must succeed" : "must be refused"}` +
          (succeeded ? "" : `  (${detail.split("\n")[0]})`),
      );
    }
  } finally {
    await asRole.end();
  }

  if (failures > 0) {
    throw new Error(
      `${failures} proof(s) failed. The role exists and has been granted; do NOT set BAS_ASK_DATABASE_URL until this passes. See runbook.md, "The bas_analyze role".`,
    );
  }

  console.log("");
  console.log("Every proof passed. Set this in .env.local (or Key Vault) as BAS_ASK_DATABASE_URL:");
  console.log("");
  console.log(`  ${roleUrl.toString()}`);
  console.log("");
  console.log("The password is shown once, here. Re-run this script to rotate it.");
}

main().catch((error: unknown) => {
  console.error(`\n${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
