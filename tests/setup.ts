import path from "node:path";
import { config as loadEnv } from "dotenv";
import { TEST_ALLOWED_DOMAIN, TEST_MAILBOX, TEST_TENANT_ID } from "./constants";

/**
 * Runs before every test file.
 *
 * The suite truncates every table between files, so it must be impossible to
 * point it at the development database by accident. Both guards below are
 * deliberate: a missing TEST_DATABASE_URL fails, and one that matches
 * DATABASE_URL fails.
 */

loadEnv({ path: path.resolve(process.cwd(), ".env.local"), quiet: true });
loadEnv({ path: path.resolve(process.cwd(), ".env"), quiet: true });

const testUrl = process.env.TEST_DATABASE_URL?.trim();
const devUrl = process.env.DATABASE_URL?.trim();

if (testUrl === undefined || testUrl.length === 0) {
  throw new Error(
    "TEST_DATABASE_URL is not set. The test suite truncates every table and " +
      "refuses to run without a database of its own. See .env.example.",
  );
}

if (devUrl !== undefined && testUrl === devUrl) {
  throw new Error(
    "TEST_DATABASE_URL and DATABASE_URL point at the same database. " +
      "Running the tests would destroy your development data.",
  );
}

// Application code reads DATABASE_URL. Redirecting it here means the tests
// exercise the real client against the test database, not a mock.
process.env.DATABASE_URL = testUrl;

// Vitest already sets NODE_ENV to "test", but the type is read-only, so assert
// rather than assign - the value matters to lib/env.ts and to the ZZTEST guard
// in lib/modules/change-orders/mail/guards.ts.
if (process.env.NODE_ENV !== "test") {
  throw new Error(`Expected NODE_ENV=test, got ${String(process.env.NODE_ENV)}`);
}

/**
 * Auth configuration for the suite.
 *
 * Forced to fixed test values rather than read from .env.local, for two
 * reasons: the tests must run before an Entra app registration exists, and a
 * tenant-mismatch assertion is only meaningful if the test knows exactly which
 * tenant the code is configured with. No test authenticates against Microsoft -
 * the sign-in path is driven with synthetic claims.
 */
process.env.AUTH_SECRET = "test-only-secret-never-used-outside-vitest";
process.env.AUTH_MICROSOFT_ENTRA_ID_ID = "test-client-id";
process.env.AUTH_MICROSOFT_ENTRA_ID_TENANT_ID = TEST_TENANT_ID;
process.env.ALLOWED_EMAIL_DOMAINS = TEST_ALLOWED_DOMAIN;
process.env.BOOTSTRAP_ADMIN_EMAIL = `bootstrap@${TEST_ALLOWED_DOMAIN}`;

/**
 * Microsoft Graph configuration for the suite.
 *
 * CO_MAILBOX is a deliberately unroutable address, not changeorder@phb1899.com.
 * Every mail test intercepts fetch, so nothing should reach the network at all -
 * but if an interception is ever missed, the request must not be aimed at the
 * live mailbox that PH+B runs its change-order process through.
 *
 * The credential variables are left UNSET on purpose. "No Graph credential
 * configured" is the state the app has to boot and serve in, so it is the
 * default the suite runs in; the tests that need a configured credential set
 * fake values themselves and clean up after.
 */
process.env.CO_MAILBOX = TEST_MAILBOX;
delete process.env.GRAPH_CLIENT_ID;
delete process.env.GRAPH_CLIENT_SECRET;
delete process.env.GRAPH_TENANT_ID;
delete process.env.GRAPH_MANAGED_IDENTITY_CLIENT_ID;

// The send gate must be off unless a test turns it on.
process.env.PHB_ALLOW_SEND = "false";
