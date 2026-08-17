import { execFileSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertLocalDatabase,
  databaseHost,
  isLocalDatabase,
} from "@/scripts/local-only";

/**
 * Guards that only matter once there is a production to run against.
 *
 * These run the real scripts as subprocesses rather than importing them. Both
 * are top-level scripts whose protection is at module scope, so importing one
 * would execute it - and the thing under test is precisely what happens when
 * somebody runs it.
 */

const projectRoot = path.resolve(process.cwd());

interface RunResult {
  status: number | null;
  output: string;
}

function runScript(script: string, env: Record<string, string>): RunResult {
  try {
    const stdout = execFileSync("npx", ["tsx", script], {
      cwd: projectRoot,
      env: { ...process.env, ...env },
      encoding: "utf8",
      stdio: "pipe",
      shell: true,
    });
    return { status: 0, output: stdout };
  } catch (error) {
    const e = error as { status?: number | null; stdout?: string; stderr?: string };
    return {
      status: e.status ?? null,
      output: `${e.stdout ?? ""}${e.stderr ?? ""}`,
    };
  }
}

describe("the local-database predicate", () => {
  it("accepts every form of loopback", () => {
    for (const url of [
      "postgresql://u:p@localhost:5432/db",
      "postgresql://u:p@LOCALHOST:5432/db",
      "postgresql://u:p@127.0.0.1:5432/db",
      "postgresql://u:p@127.1.2.3:5432/db",
      "postgresql://u:p@[::1]:5432/db",
      "postgres://u:p@localhost/db?schema=public",
    ]) {
      expect(isLocalDatabase(url), url).toBe(true);
    }
  });

  it("rejects anything else, including hostnames that merely contain 'localhost'", () => {
    for (const url of [
      "postgresql://u:p@phb-prod-pg.postgres.database.azure.com:5432/phb_platform",
      "postgresql://u:p@10.0.0.5:5432/db",
      "postgresql://u:p@db.internal:5432/db",
      // The near-misses a substring check would let through.
      "postgresql://u:p@localhost.evil.example:5432/db",
      "postgresql://u:p@notlocalhost:5432/db",
      "postgresql://u:p@127.0.0.1.evil.example:5432/db",
    ]) {
      expect(isLocalDatabase(url), url).toBe(false);
    }
  });

  it("fails closed on missing or unparseable values", () => {
    for (const url of [undefined, null, "", "   ", "not-a-url", "postgresql://"]) {
      expect(isLocalDatabase(url), String(url)).toBe(false);
    }
  });

  it("never exposes the password when it reports the host", () => {
    const url = "postgresql://admin:sup3r-s3cret@db.example.com:5432/prod";

    expect(databaseHost(url)).toBe("db.example.com");

    const error = (() => {
      try {
        assertLocalDatabase(url, "seed:dev");
        return null;
      } catch (e) {
        return e as Error;
      }
    })();

    expect(error).not.toBeNull();
    expect(error?.message).toContain("db.example.com");
    // A connection string is a credential. The message names the host only.
    expect(error?.message).not.toContain("sup3r-s3cret");
    expect(error?.message).not.toContain("postgresql://");
  });
});

describe("seed:dev cannot run against production", () => {
  /**
   * prisma/seed-dev.ts creates 130 fake employees. Against the production
   * database that is not a mess to clean up: audit_events is append-only and its
   * foreign keys are ON DELETE SET NULL, so once a fake row has any audit history
   * it cannot be deleted at all.
   */
  it("refuses when NODE_ENV is production, before touching the database", () => {
    const result = runScript("prisma/seed-dev.ts", {
      NODE_ENV: "production",
      // Deliberately unreachable. If the guard runs first - which is the point -
      // this is never dialled, and the failure names the guard, not the network.
      DATABASE_URL: "postgresql://guard:guard@127.0.0.1:1/should_never_connect",
    });

    expect(result.status).not.toBe(0);
    expect(result.output).toContain("must never run against production");
    // Proves the ordering: it never got as far as opening a connection.
    expect(result.output).not.toContain("ECONNREFUSED");
  });

  it("refuses a remote database even when NODE_ENV says development", () => {
    // The realistic accident: intent says development, the environment holds a
    // production URL. The NODE_ENV check alone would wave this through.
    const result = runScript("prisma/seed-dev.ts", {
      NODE_ENV: "development",
      DATABASE_URL:
        "postgresql://admin:sup3r-s3cret@example-pg.postgres.database.azure.com:5432/phb_platform",
    });

    expect(result.status).not.toBe(0);
    expect(result.output).toContain("not at localhost");
    expect(result.output).toContain("example-pg.postgres.database.azure.com");
    // Refused before opening a connection, and without printing the credential.
    expect(result.output).not.toContain("sup3r-s3cret");
    expect(result.output).not.toContain("ECONNREFUSED");
    expect(result.output).not.toContain("Seeded");
  });

  it("still runs against a local database", () => {
    // The guard must not have made the script unusable for its actual purpose.
    // A port nothing listens on: it gets past both guards and fails on the
    // connection, which is exactly the boundary being asserted.
    const result = runScript("prisma/seed-dev.ts", {
      NODE_ENV: "development",
      DATABASE_URL: "postgresql://u:p@127.0.0.1:1/nothing_listening_here",
    });

    expect(result.status).not.toBe(0);
    expect(result.output).not.toContain("not at localhost");
    expect(result.output).not.toContain("must never run against production");
  });

  it("the production seed has no such guard, because it is meant to run there", () => {
    // prisma/seed.ts is idempotent and safe in production - it is how the
    // bootstrap admins get created. Asserting the asymmetry on purpose: the two
    // scripts must not be confused for one another.
    const result = runScript("prisma/seed.ts", {
      NODE_ENV: "production",
      DATABASE_URL: "postgresql://guard:guard@127.0.0.1:1/should_never_connect",
    });

    expect(result.status).not.toBe(0);
    // It failed on the connection, not on a production guard.
    expect(result.output).not.toContain("must never run against production");
  });
});

describe("production refuses a Graph client secret", () => {
  /**
   * CLAUDE.md prohibition 7. Covered by tests/graph-client.test.ts at the unit
   * level; asserted here too because it is a deployment property, and this file
   * is where someone preparing a deploy will look.
   */
  it("is enforced by the credential factory, not by configuration alone", async () => {
    const source = await import("node:fs/promises").then((fs) =>
      fs.readFile(
        path.join(projectRoot, "lib/modules/change-orders/graph/credential.ts"),
        "utf8",
      ),
    );

    expect(source).toContain("isProduction");
    expect(source).toContain("GRAPH_CLIENT_SECRET is set in production");
  });

  it("is not supplied by the infrastructure either", async () => {
    const bicep = await import("node:fs/promises").then((fs) =>
      fs.readFile(path.join(projectRoot, "infra/main.bicep"), "utf8"),
    );

    // The container app must not define this environment variable at all.
    expect(bicep).not.toMatch(/name:\s*'GRAPH_CLIENT_SECRET'/);
    expect(bicep).toContain("PHB_ALLOW_SEND");
    // The send gate ships closed.
    expect(bicep).toMatch(/name:\s*'PHB_ALLOW_SEND'[\s\S]{0,80}value:\s*'false'/);
  });
});

describe("no deployment file hardcodes an organisation", () => {
  const files = [
    "infra/main.bicep",
    "infra/main.parameters.example.json",
    ".github/workflows/ci.yml",
    ".github/workflows/deploy.yml",
    "Dockerfile",
  ];

  it("contains no PH+B address, tenant, or subscription identifier", async () => {
    const fs = await import("node:fs/promises");

    for (const file of files) {
      const source = await fs.readFile(path.join(projectRoot, file), "utf8");

      expect(source, `${file} must not name the company domain`).not.toContain(
        "phb1899.com",
      );
      // The SSO tenant and client IDs recorded in docs/runbook.md.
      expect(source, `${file} must not embed the tenant id`).not.toContain(
        "48f37f84-1c36-4b3e-986c-b8b7196ad49d",
      );
      expect(source, `${file} must not embed the SSO client id`).not.toContain(
        "220921c1-f23e-4d01-b354-736884ba3d00",
      );
    }
  });
});
