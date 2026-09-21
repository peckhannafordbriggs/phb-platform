/**
 * The `bas_analyze` role: what the Analyze tab's SQL may read, as SQL.
 *
 * This is the boundary. The guard in sql-guard.ts and the READ ONLY
 * transaction in pool.ts are depth; if both had the same hole, this role is
 * what makes the worst case a wrong answer rather than a wrong action. It is
 * deliberately the SAME SHAPE as `bas_readonly_platform`
 * (C:\dev\bas-mcp\setup_readonly_role_platform.sql, phb-bas): an explicit
 * allowlist, a named withhold list, and a gate that refuses to run when the
 * database holds a bas_* object neither list mentions. Read that file's
 * header before "simplifying" this into a pattern - it has been a pattern
 * twice and was wrong both times, and the second time it would have handed
 * out the credentials table.
 *
 * A separate role rather than reusing `bas_readonly_platform`, for the reason
 * docs/BAS-B5.md gives: "a dedicated Postgres role". Grafana's password is
 * held on the machines that run Grafana; this one is held by the container
 * app. Rotating one must not break the other.
 *
 * Kept in lib/ rather than in a .sql file so that ONE definition is used by
 * `scripts/setup-bas-analyze-role.ts` (production and development) and by
 * `tests/bas-analyze-role.test.ts` (which creates a throwaway role on the test
 * database from these exact statements and then proves the refusals).
 */

export const ANALYZE_ROLE = "bas_analyze";

/**
 * Every object the role may read. The data dictionary view is the one the
 * planner is given as its schema, so it has to be here.
 */
export const ANALYZE_ALLOWLIST: readonly string[] = [
  // Hierarchy and metadata.
  "bas_orgs",
  "bas_projects",
  "bas_sites",
  "bas_stations",
  "bas_equipment",
  // Controlled vocabularies.
  "bas_equipment_types",
  "bas_point_roles",
  // Points, their relationships, and the numbers.
  "bas_points",
  "bas_point_links",
  "bas_readings",
  // Operational.
  "bas_sync_checkpoints",
  "bas_ingest_runs",
  "bas_data_gaps",
  // The six views.
  "bas_v_point",
  "bas_v_reading",
  "bas_v_setpoint_pair",
  "bas_v_command_status_pair",
  "bas_v_collection_health",
  "bas_v_data_dictionary",
];

/**
 * bas_* objects the role must NOT read, with the reason. Listing them is what
 * lets the gate tell "decided to hide" from "nobody has looked". They are
 * actively REVOKED, not merely left out, so a re-run removes a grant an
 * earlier hand-run may have made.
 */
export const ANALYZE_WITHHELD: ReadonlyArray<{ name: string; reason: string }> = [
  {
    name: "bas_station_credentials",
    reason:
      "AES-256-GCM ciphertext of the Niagara logins. Being a separate table is " +
      "the whole mechanism by which a read-only role can be refused it.",
  },
];

/**
 * The platform's own tables, revoked by name. `REVOKE ALL ON ALL TABLES` below
 * already covers them; naming them means a reader can see the question was
 * asked, and a future audit can grep for the table it cares about.
 */
export const PLATFORM_TABLES: readonly string[] = [
  "employees",
  "audit_events",
  "module_grants",
  "modules",
  "positions",
  "departments",
  "draft_locks",
  "_prisma_migrations",
];

/** The statement timeout set ON THE ROLE. pool.ts sets a shorter one per query. */
export const ROLE_STATEMENT_TIMEOUT = "30s";

function ident(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/**
 * The gate, as one SQL statement. Raises if the database holds a bas_* object
 * (table, view, materialized view or partitioned table) that is on neither
 * list, if an allowlisted name is missing, or if a name is on both lists.
 *
 * Run FIRST, before anything is granted or revoked, so a run that fails the
 * gate changes nothing.
 */
export function analyzeRoleGateSql(): string {
  const allow = ANALYZE_ALLOWLIST.map((n) => `'${n}'`).join(", ");
  const withhold = ANALYZE_WITHHELD.map((w) => `'${w.name}'`).join(", ");

  return `
DO $gate$
DECLARE
  present      text[];
  missing      text[];
  unclassified text[];
  conflicted   text[];
  allow_list   text[] := ARRAY[${allow}];
  hold_list    text[] := ARRAY[${withhold}];
BEGIN
  SELECT coalesce(array_agg(c.relname ORDER BY c.relname), '{}')
    INTO present
    FROM pg_class c
    JOIN pg_namespace ns ON ns.oid = c.relnamespace
   WHERE ns.nspname = 'public'
     AND c.relkind IN ('r', 'v', 'm', 'p')
     AND c.relname LIKE 'bas\\_%';

  SELECT coalesce(array_agg(a ORDER BY a), '{}') INTO conflicted
    FROM unnest(allow_list) AS a WHERE a = ANY (hold_list);
  IF array_length(conflicted, 1) > 0 THEN
    RAISE EXCEPTION 'These objects are both allowed and withheld: %. Pick one.', conflicted;
  END IF;

  SELECT coalesce(array_agg(p ORDER BY p), '{}') INTO unclassified
    FROM unnest(present) AS p
   WHERE NOT (p = ANY (allow_list)) AND NOT (p = ANY (hold_list));
  IF array_length(unclassified, 1) > 0 THEN
    RAISE EXCEPTION 'Unclassified bas_* object(s): %. Nothing has been granted or revoked. Add each name to ANALYZE_ALLOWLIST or ANALYZE_WITHHELD in lib/modules/bas/analyze/role.ts.', unclassified;
  END IF;

  SELECT coalesce(array_agg(a ORDER BY a), '{}') INTO missing
    FROM unnest(allow_list) AS a WHERE NOT (a = ANY (present));
  IF array_length(missing, 1) > 0 THEN
    RAISE EXCEPTION 'Allowlisted object(s) not found in this database: %. Apply the platform migrations first.', missing;
  END IF;
END
$gate$;`.trim();
}

/**
 * Every statement after the gate, in order, for a role that already exists.
 *
 * Creating the role and setting its password are NOT here: a password is a
 * value this module never sees. The script and the test each create the role
 * their own way, then apply these.
 *
 * `GRANT CONNECT` uses `current_database()` through EXECUTE because the
 * database name differs between development, test and Azure.
 */
export function analyzeRoleGrantStatements(role: string = ANALYZE_ROLE): string[] {
  const r = ident(role);
  const statements: string[] = [];

  statements.push(
    `DO $c$ BEGIN EXECUTE format('GRANT CONNECT ON DATABASE %I TO ${r}', current_database()); END $c$;`,
  );
  // USAGE is not a read grant. It only makes the schema addressable.
  statements.push(`GRANT USAGE ON SCHEMA public TO ${r};`);

  for (const name of ANALYZE_ALLOWLIST) {
    statements.push(`GRANT SELECT ON public.${ident(name)} TO ${r};`);
  }

  // Withheld: revoke if present. A withheld name may legitimately not exist
  // yet, unlike an allowlisted one.
  for (const { name } of ANALYZE_WITHHELD) {
    statements.push(
      `DO $w$ BEGIN IF to_regclass('public.${name}') IS NOT NULL THEN EXECUTE 'REVOKE ALL ON public.${ident(name)} FROM ${r}'; END IF; END $w$;`,
    );
  }

  // Everything that is not a read, everywhere in public.
  statements.push(
    `REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON ALL TABLES IN SCHEMA public FROM ${r};`,
  );
  statements.push(`REVOKE CREATE ON SCHEMA public FROM ${r};`);
  statements.push(`REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM ${r};`);
  statements.push(`REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM ${r};`);
  // TEMP is deliberately NOT revoked. It is a PUBLIC grant on the database,
  // so `REVOKE TEMP ... FROM bas_analyze` has no effect (measured: the role
  // could still CREATE TEMP TABLE after it), and `REVOKE ... FROM PUBLIC`
  // would change what every other role - the collector included - may do. A
  // temporary table holds no BAS data and dies with the session; the READ
  // ONLY transaction pool.ts opens refuses CREATE anyway, and the cursor
  // refuses anything that is not a SELECT. tests/bas-analyze-role.test.ts
  // proves the refusal at the layer that actually provides it.

  for (const name of PLATFORM_TABLES) {
    statements.push(
      `DO $p$ BEGIN IF to_regclass('public.${name}') IS NOT NULL THEN EXECUTE 'REVOKE ALL ON public.${ident(name)} FROM ${r}'; END IF; END $p$;`,
    );
  }

  // Role-level defaults. A client can turn default_transaction_read_only off
  // - runbook.md, *Two independent layers stop writes* - which is why the
  // grants above are the layer that counts. pool.ts opens READ ONLY anyway.
  statements.push(`ALTER ROLE ${r} SET statement_timeout = '${ROLE_STATEMENT_TIMEOUT}';`);
  statements.push(`ALTER ROLE ${r} SET default_transaction_read_only = on;`);

  return statements;
}

/**
 * What to prove after granting. Each entry is a statement and whether it must
 * succeed. The refusals are the test - a grant that lets the right thing
 * through proves nothing on its own.
 */
export interface RoleProof {
  sql: string;
  mustSucceed: boolean;
  why: string;
}

export function analyzeRoleProofs(): RoleProof[] {
  return [
    {
      sql: "SELECT count(*) FROM bas_points",
      mustSucceed: true,
      why: "the allowlist lets a read through",
    },
    {
      sql: "SELECT count(*) FROM bas_v_data_dictionary",
      mustSucceed: true,
      why: "the planner's schema source is readable",
    },
    {
      sql: "SELECT count(*) FROM bas_station_credentials",
      mustSucceed: false,
      why: "the credentials table is withheld",
    },
    {
      sql: "SELECT count(*) FROM employees",
      mustSucceed: false,
      why: "the employee directory is not BAS data",
    },
    {
      sql: "SELECT count(*) FROM audit_events",
      mustSucceed: false,
      why: "the audit log is not BAS data",
    },
    {
      sql: "SELECT count(*) FROM module_grants",
      mustSucceed: false,
      why: "grants are not BAS data",
    },
    {
      sql: "INSERT INTO bas_orgs (name) VALUES ('bas_analyze_role_proof')",
      mustSucceed: false,
      why: "no write grant - tested with read-only OFF, so the grant is what refuses it",
    },
    {
      sql: "CREATE TABLE bas_analyze_role_proof (x int)",
      mustSucceed: false,
      why: "no CREATE on the schema",
    },
  ];
}
