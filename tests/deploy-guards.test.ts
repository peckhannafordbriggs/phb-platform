import { execFileSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertLocalDatabase,
  databaseHost,
  isLocalDatabase,
} from "@/prisma/local-only";

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

describe("the Anthropic API key reaches the container only by Key Vault reference", () => {
  const readBicep = () =>
    import("node:fs/promises").then((fs) =>
      fs.readFile(path.join(projectRoot, "infra/main.bicep"), "utf8"),
    );

  it("is an environment variable backed by a secretRef, never a plain value", async () => {
    const bicep = await readBicep();

    expect(bicep).toMatch(
      /name:\s*'ANTHROPIC_API_KEY'[\s\S]{0,80}secretRef:\s*'anthropic-api-key'/,
    );
    expect(bicep).not.toMatch(/name:\s*'ANTHROPIC_API_KEY'[\s\S]{0,80}value:/);
  });

  it("is never a template parameter - the value is set in the vault by hand", async () => {
    const bicep = await readBicep();

    // A secure string parameter would put the key on every deploy's command
    // line and let a blank redeploy overwrite it. The only parameter about it
    // is the boolean saying the secret already exists.
    expect(bicep).toMatch(/param anthropicApiKeyInKeyVault bool = false/);
    expect(bicep).not.toMatch(/param \w*[aA]nthropic\w* string/);
    // And the template never writes the secret itself.
    expect(bicep).not.toMatch(
      /vaults\/secrets@[\d-]+'\s*=\s*\{[\s\S]{0,120}name:\s*'ANTHROPIC-API-KEY'/,
    );
  });

  it("is read lazily by the app, so a missing key cannot stop the boot", async () => {
    const { readAnthropicApiKey } = await import("@/lib/env");
    const before = process.env.ANTHROPIC_API_KEY;
    try {
      delete process.env.ANTHROPIC_API_KEY;
      expect(readAnthropicApiKey()).toBeNull();
      // .env.example ships it as "", and an Azure setting left blank arrives the
      // same way. Blank is absent, not malformed.
      process.env.ANTHROPIC_API_KEY = "   ";
      expect(readAnthropicApiKey()).toBeNull();
      process.env.ANTHROPIC_API_KEY = " not-a-real-key ";
      expect(readAnthropicApiKey()).toBe("not-a-real-key");
    } finally {
      if (before === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = before;
    }
  });
});

/**
 * The BAS credential key, the same way (2026-10-01). It encrypts the Niagara
 * station passwords; the deployed Settings tab could not decrypt them because
 * the container app was never given it. The mutation this block is for:
 * remove either env entry from the bicep and the first test here fails.
 */
describe("the BAS credential key reaches the container only by Key Vault reference", () => {
  const readBicep = () =>
    import("node:fs/promises").then((fs) =>
      fs.readFile(path.join(projectRoot, "infra/main.bicep"), "utf8"),
    );
  const readSource = (file: string) =>
    import("node:fs/promises").then((fs) =>
      fs.readFile(path.join(projectRoot, file), "utf8"),
    );

  it("is an environment variable backed by a secretRef, never a plain value", async () => {
    const bicep = await readBicep();
    expect(bicep).toMatch(
      /name:\s*'BAS_CREDENTIAL_KEY'[\s\S]{0,80}secretRef:\s*'bas-credential-key'/,
    );
    expect(bicep).not.toMatch(/name:\s*'BAS_CREDENTIAL_KEY'[\s\S]{0,80}value:/);
    // The secretRef resolves to a Key Vault URL under the managed identity,
    // in the vault's naming style (DATABASE-URL, AUTH-SECRET, ANTHROPIC-API-KEY).
    expect(bicep).toMatch(/var basCredentialKeySecretName = 'BAS-CREDENTIAL-KEY'/);
    expect(bicep).toMatch(
      /name:\s*'bas-credential-key'\s*keyVaultUrl:\s*'\$\{keyVault\.properties\.vaultUri\}secrets\/\$\{basCredentialKeySecretName\}'\s*identity:\s*identity\.id/,
    );
  });

  it("carries the key version beside it as a plain value, because it is not a secret", async () => {
    const bicep = await readBicep();
    // currentKeyVersion in credentials.ts reads it when a password is saved;
    // decryption does not. The office PC's rows carry version 1, so the
    // default is 1 and anything else is a deliberate rotation.
    expect(bicep).toMatch(/param basCredentialKeyVersion string = '1'/);
    expect(bicep).toMatch(
      /name:\s*'BAS_CREDENTIAL_KEY_VERSION'[\s\S]{0,80}value:\s*basCredentialKeyVersion/,
    );
    expect(bicep).not.toMatch(/name:\s*'BAS_CREDENTIAL_KEY_VERSION'[\s\S]{0,80}secretRef:/);
  });

  it("is never a template parameter - the value is set in the vault by hand, byte-identical to the collector's", async () => {
    const bicep = await readBicep();
    expect(bicep).toMatch(/param basCredentialKeyInKeyVault bool = false/);
    // The only string parameter about it is the version, which is not a
    // secret; nothing carries the key itself, secure or otherwise.
    expect(bicep).not.toMatch(/param \w*[cC]redentialKey(?!Version)\w* string/);
    expect(bicep).not.toMatch(/@secure\(\)\s*param \w*[cC]redentialKey/);
    // And the template never writes the secret itself.
    expect(bicep).not.toMatch(
      /vaults\/secrets@[\d-]+'\s*=\s*\{[\s\S]{0,120}name:\s*'BAS-CREDENTIAL-KEY'/,
    );
  });

  it("needs no new role assignment: the identity already holds Key Vault Secrets User on the whole vault", async () => {
    const bicep = await readBicep();
    // Asserted from the grants in the template, not assumed. One role
    // assignment scoped to the vault itself, for the container app's identity,
    // with the Secrets User role id - which covers every secret in the vault,
    // the two set by hand included. There is no per-secret assignment and
    // there must not need to be.
    const vaultAssignments = bicep.match(
      /resource \w+ 'Microsoft\.Authorization\/roleAssignments@[\d-]+' = \{\s*scope: keyVault[\s\S]*?\n\}/g,
    );
    expect(vaultAssignments, "one role assignment scoped to the vault").toHaveLength(1);
    const assignment = vaultAssignments![0]!;
    expect(assignment).toContain("keyVaultSecretsUserRoleId");
    expect(assignment).toMatch(/principalId:\s*identity\.properties\.principalId/);
    expect(bicep).toMatch(
      /var keyVaultSecretsUserRoleId = '4633458b-17de-408a-b874-0445c86b69e6'/,
    );
    // Both hand-set secrets are read under that same identity.
    for (const secret of ["anthropic-api-key", "bas-credential-key"]) {
      expect(bicep).toMatch(
        new RegExp(`name:\\s*'${secret}'[\\s\\S]{0,160}identity:\\s*identity\\.id`),
      );
    }
    // The app waits for the grant before it starts.
    expect(bicep).toMatch(/dependsOn:\s*\[[\s\S]{0,80}keyVaultRead/);
  });

  it("spells each variable's name in lib/env.ts and nowhere else in the readers", async () => {
    const env = await import("@/lib/env");
    expect(env.ANTHROPIC_API_KEY_VAR).toBe("ANTHROPIC_API_KEY");
    expect(env.BAS_CREDENTIAL_KEY_VAR).toBe("BAS_CREDENTIAL_KEY");
    expect(env.BAS_CREDENTIAL_KEY_VERSION_VAR).toBe("BAS_CREDENTIAL_KEY_VERSION");
    // The readers import the name; a literal in either would be a second
    // place a rename has to reach. Comments may mention it; code may not.
    const strip = (source: string) =>
      source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    const credentials = strip(await readSource("lib/modules/bas/credentials.ts"));
    expect(credentials).not.toMatch(/["'`]BAS_CREDENTIAL_KEY(_VERSION)?["'`]/);
    expect(credentials).not.toMatch(/process\.env\.BAS_CREDENTIAL_KEY/);
    const analyze = strip(await readSource("lib/modules/bas/analyze/env.ts"));
    expect(analyze).not.toMatch(/["'`]ANTHROPIC_API_KEY["'`]/);
    // And the bicep spells the same names, so the three cannot drift.
    const bicep = await readBicep();
    for (const name of [env.ANTHROPIC_API_KEY_VAR, env.BAS_CREDENTIAL_KEY_VAR, env.BAS_CREDENTIAL_KEY_VERSION_VAR]) {
      expect(bicep).toContain(`name: '${name}'`);
    }
  });

  it("is read lazily, so a missing key disables credential storage and nothing else", async () => {
    const { credentialKeyState, currentKeyVersion } = await import("@/lib/modules/bas/credentials");
    const before = process.env.BAS_CREDENTIAL_KEY;
    const beforeVersion = process.env.BAS_CREDENTIAL_KEY_VERSION;
    try {
      delete process.env.BAS_CREDENTIAL_KEY;
      expect(credentialKeyState()).toEqual({ available: false, reason: "key_missing" });
      process.env.BAS_CREDENTIAL_KEY = "   ";
      expect(credentialKeyState()).toEqual({ available: false, reason: "key_missing" });
      delete process.env.BAS_CREDENTIAL_KEY_VERSION;
      expect(currentKeyVersion()).toBe(1);
      process.env.BAS_CREDENTIAL_KEY_VERSION = "2";
      expect(currentKeyVersion()).toBe(2);
    } finally {
      if (before === undefined) delete process.env.BAS_CREDENTIAL_KEY;
      else process.env.BAS_CREDENTIAL_KEY = before;
      if (beforeVersion === undefined) delete process.env.BAS_CREDENTIAL_KEY_VERSION;
      else process.env.BAS_CREDENTIAL_KEY_VERSION = beforeVersion;
    }
  });

  it("has an example parameters file that ships both flags off and the version at 1", async () => {
    const example = JSON.parse(
      await readSource("infra/main.parameters.example.json"),
    ) as { parameters: Record<string, { value: unknown }> };
    expect(example.parameters.anthropicApiKeyInKeyVault?.value).toBe(false);
    expect(example.parameters.basCredentialKeyInKeyVault?.value).toBe(false);
    expect(example.parameters.basCredentialKeyVersion?.value).toBe("1");
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

  /**
   * A wider net for the two identifiers that must never be committed anywhere,
   * as opposed to the tenant and app registration ids, which runbook.md
   * legitimately records. The runbook is included because it carries the
   * verbatim access requests, and filling a real value into one of those
   * templates is the easiest way to commit a subscription id by accident - it
   * has happened once.
   */
  const everywhere = [
    ...files,
    "runbook.md",
    "CLAUDE.md",
    "HANDOVER.md",
    "infra/README.md",
  ];

  it("never commits the subscription id or resource group, in any file", async () => {
    const fs = await import("node:fs/promises");

    for (const file of everywhere) {
      const source = await fs.readFile(path.join(projectRoot, file), "utf8");

      expect(source, `${file} must not embed the subscription id`).not.toContain(
        "3d468153-f247-431b-a1b2-8055517630fa",
      );
      expect(source, `${file} must not embed the resource group`).not.toContain(
        "rg-phb-platform-prod",
      );
    }
  });

  it("contains no PH+B address, tenant, or subscription identifier", async () => {
    const fs = await import("node:fs/promises");

    for (const file of files) {
      const source = await fs.readFile(path.join(projectRoot, file), "utf8");

      expect(source, `${file} must not name the company domain`).not.toContain(
        "phb1899.com",
      );
      // The SSO tenant and client IDs recorded in runbook.md.
      expect(source, `${file} must not embed the tenant id`).not.toContain(
        "48f37f84-1c36-4b3e-986c-b8b7196ad49d",
      );
      expect(source, `${file} must not embed the SSO client id`).not.toContain(
        "220921c1-f23e-4d01-b354-736884ba3d00",
      );
      // The subscription and resource group are chosen on the az command line
      // and set as CI variables. They are not secret, but committing them is
      // what turns a generic template into this company's template.
      expect(source, `${file} must not embed the subscription id`).not.toContain(
        "3d468153-f247-431b-a1b2-8055517630fa",
      );
      expect(source, `${file} must not embed the resource group`).not.toContain(
        "rg-phb-platform-prod",
      );
    }
  });

  it("keeps the filled-in parameters file out of git", async () => {
    const fs = await import("node:fs/promises");
    const gitignore = await fs.readFile(path.join(projectRoot, ".gitignore"), "utf8");

    // This is the file that legitimately holds the subscription, tenant and
    // admin addresses. The check above only passes because it is ignored.
    expect(gitignore).toContain("infra/main.parameters.json");
  });
});

describe("the deploy workflow addresses the database server correctly", () => {
  /**
   * `az postgres flexible-server firewall-rule` takes the SERVER as
   * `-s`/`--server-name` and the RULE as `-n`/`--name`. Passing the server as
   * `--name` fails with "the following arguments are required:
   * --server-name/-s", which reads like an unset workflow variable rather than
   * a wrong flag.
   *
   * This is asserted because it cannot be caught any other way: the command
   * runs only on a GitHub runner, and the step immediately after it is the
   * migration. It shipped wrong once.
   */
  it("passes the server as --server-name, not --name", async () => {
    const workflow = await import("node:fs/promises").then((fs) =>
      fs.readFile(path.join(projectRoot, ".github/workflows/deploy.yml"), "utf8"),
    );

    const firewallCommands = workflow
      .split("az postgres flexible-server firewall-rule")
      .slice(1);

    expect(firewallCommands.length).toBe(2);

    for (const command of firewallCommands) {
      // Only look at the flags belonging to this invocation.
      const body = command.split("- name:")[0] ?? "";
      expect(body).toContain("--server-name");
      expect(body, "--rule-name is not a flag on this command").not.toContain(
        "--rule-name",
      );
      expect(
        body,
        "the server must not be passed as --name",
      ).not.toMatch(/--name "\$\{\{ vars\.AZURE_POSTGRES_SERVER \}\}"/);
    }
  });
});

describe("the database collation is set explicitly", () => {
  /**
   * Every department and position list is ORDER BY name ASC, so the ordering
   * belongs to the database. `C` and `POSIX` compare raw bytes and sort `AI`
   * ahead of `Administrative`. It cannot be corrected after the database has
   * data in it without a dump and restore, which is why it is asserted at
   * deploy-preparation time rather than discovered afterwards.
   *
   * This tests the TEMPLATE. It cannot test the running database, because the
   * collation a server actually applies is not necessarily the one it was
   * asked for - scripts/verify-prod-database.ts does that against real values,
   * and has to be run against the deployed server before migrating.
   */
  it("names a locale-aware collation, not C or POSIX", async () => {
    const bicep = await import("node:fs/promises").then((fs) =>
      fs.readFile(path.join(projectRoot, "infra/main.bicep"), "utf8"),
    );

    const match = /collation:\s*'([^']+)'/.exec(bicep);
    expect(match, "infra/main.bicep must set a collation explicitly").not.toBeNull();
    expect(["C", "POSIX"]).not.toContain(match?.[1]);
    expect(match?.[1]).toBe("en_US.utf8");
  });

  it("has a verification script that asserts on values rather than the name", async () => {
    const source = await import("node:fs/promises").then((fs) =>
      fs.readFile(path.join(projectRoot, "scripts/verify-prod-database.ts"), "utf8"),
    );

    // The ordering assertion, not a datcollate string comparison, is the test.
    expect(source).toContain("'Administrative'");
    expect(source).toContain("'AI'");
    expect(source).toMatch(/ORDER BY name/);
  });
});

describe("the image ships public/", () => {
  /**
   * `output: "standalone"` traces imports, and nothing imports a file in
   * public/ - it is served by path - so the standalone output never contains
   * it. It has to be copied into the runtime stage alongside .next/static, and
   * the first production image was built without that line: every request for
   * /phb-logo.png answered with the app's own 404 page while the same file
   * served fine from `next dev` (2026-09-16). Nothing local can catch a
   * Dockerfile omission, so this reads the Dockerfile.
   */
  it("copies public/ into the runtime stage, next to .next/static", async () => {
    const fs = await import("node:fs/promises");
    const dockerfile = await fs.readFile(path.join(projectRoot, "Dockerfile"), "utf8");

    // The runtime stage is everything after the last FROM. The copy has to be
    // THERE - a copy in the build stage is what `next build` reads and is not
    // what ships.
    const runtime = dockerfile.slice(dockerfile.lastIndexOf("FROM "));

    expect(runtime).toContain("COPY --from=build --chown=node:node /app/public ./public");
    expect(runtime).toContain(
      "COPY --from=build --chown=node:node /app/.next/static ./.next/static",
    );
  });

  it("does not let .dockerignore take public/ back out of the build context", async () => {
    const fs = await import("node:fs/promises");
    const ignore = await fs.readFile(path.join(projectRoot, ".dockerignore"), "utf8");
    const lines = ignore
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("#"));

    expect(lines).not.toContain("public");
    expect(lines).not.toContain("public/");
    expect(lines).not.toContain("**/public");
  });
});
