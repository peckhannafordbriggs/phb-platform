import { execFileSync, spawnSync } from "node:child_process";
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
    // Nor the CIP app's: it signs in with the managed identity too.
    expect(bicep).not.toMatch(/PHB_PLATFORM_CIP_APP_SECRET/);
  });
});

describe("the production send gate is open, by decision", () => {
  /**
   * PHB_ALLOW_SEND was pinned to 'false' by the template from the first
   * deployment until 2026-10-14, when the platform owner opened it after a
   * supervised test send on 2026-09-29. The template now pins 'true' so a
   * template deployment cannot silently close the gate again (the deploy
   * workflow's `az containerapp update --image` keeps env vars; a template
   * deployment replaces them - see "A template deployment must be told which
   * image to keep" in CLAUDE.md). Prohibition 1 is unchanged: the gate decides
   * whether a human's deliberate send is allowed, never whether anything sends
   * on its own.
   */
  it("is pinned to exactly the lowercase string 'true' in the template", async () => {
    const bicep = await import("node:fs/promises").then((fs) =>
      fs.readFile(path.join(projectRoot, "infra/main.bicep"), "utf8"),
    );

    // Present as a plain value - never a secretRef, never absent. Absent reads
    // as closed, which is the silent failure the pin exists to prevent.
    expect(bicep).toMatch(/name:\s*'PHB_ALLOW_SEND'[\s\S]{0,80}value:\s*'true'/);
    // The gate compares with === "true": 'TRUE', 'True' and '1' all leave it
    // shut (runbook.md -> "Nothing sends, and that is correct"). A case slip in
    // the template would close production sending with no error anywhere.
    expect(bicep).not.toMatch(/name:\s*'PHB_ALLOW_SEND'[\s\S]{0,80}value:\s*'(TRUE|True|1|yes|false)'/);
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
    // All four hand-set secrets are read under that same identity.
    for (const secret of ["anthropic-api-key", "co-anthropic-api-key", "bas-credential-key", "bas-ask-database-url"]) {
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
    expect(env.CO_ANTHROPIC_API_KEY_VAR).toBe("CO_ANTHROPIC_API_KEY");
    expect(env.BAS_CREDENTIAL_KEY_VAR).toBe("BAS_CREDENTIAL_KEY");
    expect(env.BAS_CREDENTIAL_KEY_VERSION_VAR).toBe("BAS_CREDENTIAL_KEY_VERSION");
    expect(env.BAS_ASK_DATABASE_URL_VAR).toBe("BAS_ASK_DATABASE_URL");
    // The readers import the name; a literal in either would be a second
    // place a rename has to reach. Comments may mention it; code may not.
    const strip = (source: string) =>
      source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    const credentials = strip(await readSource("lib/modules/bas/credentials.ts"));
    expect(credentials).not.toMatch(/["'`]BAS_CREDENTIAL_KEY(_VERSION)?["'`]/);
    expect(credentials).not.toMatch(/process\.env\.BAS_CREDENTIAL_KEY/);
    const analyze = strip(await readSource("lib/modules/bas/analyze/env.ts"));
    expect(analyze).not.toMatch(/["'`]ANTHROPIC_API_KEY["'`]/);
    expect(analyze).not.toMatch(/["'`]BAS_ASK_DATABASE_URL["'`]/);
    const changeOrders = strip(await readSource("lib/modules/change-orders/anthropic-env.ts"));
    expect(changeOrders).not.toMatch(/["'`]CO_ANTHROPIC_API_KEY["'`]/);
    expect(changeOrders).not.toMatch(/process\.env\.CO_ANTHROPIC_API_KEY/);
    // And the bicep spells the same names, so the readers cannot drift from it.
    const bicep = await readBicep();
    for (const name of [env.ANTHROPIC_API_KEY_VAR, env.CO_ANTHROPIC_API_KEY_VAR, env.BAS_CREDENTIAL_KEY_VAR, env.BAS_CREDENTIAL_KEY_VERSION_VAR, env.BAS_ASK_DATABASE_URL_VAR]) {
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
    expect(example.parameters.coAnthropicApiKeyInKeyVault?.value).toBe(false);
    expect(example.parameters.basCredentialKeyInKeyVault?.value).toBe(false);
    expect(example.parameters.basAskDatabaseUrlInKeyVault?.value).toBe(false);
    expect(example.parameters.basCredentialKeyVersion?.value).toBe("1");
  });
});

describe("the Analyze database URL reaches the container only by Key Vault reference (2026-10-13)", () => {
  const readBicep = () =>
    import("node:fs/promises").then((fs) =>
      fs.readFile(path.join(projectRoot, "infra/main.bicep"), "utf8"),
    );

  it("is an environment variable backed by a secretRef, never a plain value", async () => {
    const bicep = await readBicep();
    expect(bicep).toMatch(
      /name:\s*'BAS_ASK_DATABASE_URL'[\s\S]{0,80}secretRef:\s*'bas-ask-database-url'/,
    );
    expect(bicep).not.toMatch(/name:\s*'BAS_ASK_DATABASE_URL'[\s\S]{0,80}value:/);
    expect(bicep).toMatch(/var basAskDatabaseUrlSecretName = 'BAS-ASK-DATABASE-URL'/);
    expect(bicep).toMatch(
      /name:\s*'bas-ask-database-url'\s*keyVaultUrl:\s*'\$\{keyVault\.properties\.vaultUri\}secrets\/\$\{basAskDatabaseUrlSecretName\}'\s*identity:\s*identity\.id/,
    );
  });

  it("is behind a boolean that defaults to false, and is never a template parameter or written by the template", async () => {
    const bicep = await readBicep();
    expect(bicep).toMatch(/param basAskDatabaseUrlInKeyVault bool = false/);
    // The URL carries the role's password. Nothing carries it as a parameter,
    // secure or otherwise, and the template never writes the secret.
    expect(bicep).not.toMatch(/param \w*[aA]skDatabaseUrl\w* string/);
    expect(bicep).not.toMatch(/@secure\(\)\s*param \w*[aA]skDatabaseUrl/);
    expect(bicep).not.toMatch(
      /vaults\/secrets@[\d-]+'\s*=\s*\{[\s\S]{0,120}name:\s*'BAS-ASK-DATABASE-URL'/,
    );
    // Both the secret entry and the env entry are inside the same conditional,
    // so the flag off leaves no dangling reference.
    expect(bicep).toMatch(/\.\.\.\(basAskDatabaseUrlInKeyVault\s*\?\s*\[\s*\{\s*name:\s*'bas-ask-database-url'/);
    expect(bicep).toMatch(/\.\.\.\(basAskDatabaseUrlInKeyVault\s*\?\s*\[\s*\{\s*name:\s*'BAS_ASK_DATABASE_URL'/);
  });

  it("is not DATABASE_URL: the platform's own connection stays its own secret", async () => {
    const bicep = await readBicep();
    expect(bicep).toMatch(/name:\s*'DATABASE_URL'[\s\S]{0,80}secretRef:\s*'database-url'/);
    expect(bicep).not.toMatch(/name:\s*'BAS_ASK_DATABASE_URL'[\s\S]{0,80}secretRef:\s*'database-url'/);
  });
});

/**
 * The Change Orders module's own Anthropic key (2026-10-16), the fourth
 * hand-set secret. A DIFFERENT key from ANTHROPIC_API_KEY, not an alias: the
 * two modules are billed, rate-limited and revoked independently. The
 * per-module separation itself is tests/anthropic-key-per-module.test.ts;
 * this block is the Key Vault wiring, the same shape as the three above.
 */
describe("the Change Orders Anthropic key reaches the container only by Key Vault reference (2026-10-16)", () => {
  const readBicep = () =>
    import("node:fs/promises").then((fs) =>
      fs.readFile(path.join(projectRoot, "infra/main.bicep"), "utf8"),
    );

  it("is an environment variable backed by its own secretRef, never a plain value", async () => {
    const bicep = await readBicep();
    expect(bicep).toMatch(
      /name:\s*'CO_ANTHROPIC_API_KEY'[\s\S]{0,80}secretRef:\s*'co-anthropic-api-key'/,
    );
    expect(bicep).not.toMatch(/name:\s*'CO_ANTHROPIC_API_KEY'[\s\S]{0,80}value:/);
    expect(bicep).toMatch(/var coAnthropicApiKeySecretName = 'CO-ANTHROPIC-API-KEY'/);
    expect(bicep).toMatch(
      /name:\s*'co-anthropic-api-key'\s*keyVaultUrl:\s*'\$\{keyVault\.properties\.vaultUri\}secrets\/\$\{coAnthropicApiKeySecretName\}'\s*identity:\s*identity\.id/,
    );
  });

  it("is behind its own boolean that defaults to false, and is never a template parameter or written by the template", async () => {
    const bicep = await readBicep();
    expect(bicep).toMatch(/param coAnthropicApiKeyInKeyVault bool = false/);
    expect(bicep).not.toMatch(/param \w*[aA]nthropic\w* string/);
    expect(bicep).not.toMatch(
      /vaults\/secrets@[\d-]+'\s*=\s*\{[\s\S]{0,120}name:\s*'CO-ANTHROPIC-API-KEY'/,
    );
    // Both the secret entry and the env entry are inside the same conditional,
    // so the flag off leaves no dangling reference.
    expect(bicep).toMatch(/\.\.\.\(coAnthropicApiKeyInKeyVault\s*\?\s*\[\s*\{\s*name:\s*'co-anthropic-api-key'/);
    expect(bicep).toMatch(/\.\.\.\(coAnthropicApiKeyInKeyVault\s*\?\s*\[\s*\{\s*name:\s*'CO_ANTHROPIC_API_KEY'/);
  });

  it("is not the BAS key: neither variable resolves to the other's secret", async () => {
    const bicep = await readBicep();
    // The mutation this is for: wiring CO_ANTHROPIC_API_KEY to the existing
    // 'anthropic-api-key' secretRef would deploy cleanly and bill the
    // change-order pipeline to the BAS key.
    expect(bicep).not.toMatch(/name:\s*'CO_ANTHROPIC_API_KEY'[\s\S]{0,80}secretRef:\s*'anthropic-api-key'/);
    expect(bicep).not.toMatch(/name:\s*'ANTHROPIC_API_KEY'[\s\S]{0,80}secretRef:\s*'co-anthropic-api-key'/);
    // And the two flags are independent: the BAS entries do not depend on the
    // CO flag or the reverse.
    expect(bicep).not.toMatch(/\.\.\.\(anthropicApiKeyInKeyVault\s*\?\s*\[\s*\{\s*name:\s*'(co-anthropic-api-key|CO_ANTHROPIC_API_KEY)'/);
    expect(bicep).not.toMatch(/\.\.\.\(coAnthropicApiKeyInKeyVault\s*\?\s*\[\s*\{\s*name:\s*'(anthropic-api-key|ANTHROPIC_API_KEY)'/);
  });

  it("is read lazily by the app, never falling back to the BAS key", async () => {
    const { readChangeOrderAnthropicApiKey, readAnthropicApiKey } = await import("@/lib/env");
    const before = process.env.CO_ANTHROPIC_API_KEY;
    const beforeBas = process.env.ANTHROPIC_API_KEY;
    try {
      delete process.env.CO_ANTHROPIC_API_KEY;
      process.env.ANTHROPIC_API_KEY = "bas-key-never-used";
      expect(readChangeOrderAnthropicApiKey()).toBeNull();
      process.env.CO_ANTHROPIC_API_KEY = "   ";
      expect(readChangeOrderAnthropicApiKey()).toBeNull();
      process.env.CO_ANTHROPIC_API_KEY = " co-key-never-used ";
      expect(readChangeOrderAnthropicApiKey()).toBe("co-key-never-used");
      expect(readAnthropicApiKey()).toBe("bas-key-never-used");
    } finally {
      if (before === undefined) delete process.env.CO_ANTHROPIC_API_KEY;
      else process.env.CO_ANTHROPIC_API_KEY = before;
      if (beforeBas === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = beforeBas;
    }
  });
});

/**
 * Needs Review's app registration reaches the container as three plain
 * identifiers and never a secret (2026-10-21). The same shape as the CIP
 * app: client id, tenant id and the folder are template parameters because
 * they are not secrets; the developer-machine secret has no parameter, no
 * env entry and no Key Vault reference, because production presents the
 * managed identity's token instead. The mutation this block is for: add a
 * `PHB_PLATFORM_CO_REVIEW_APP_SECRET` entry to the bicep and the first test
 * fails; remove an identifier entry and the second does.
 */
describe("the Needs Review app registration reaches the container without a secret", () => {
  const readBicep = () =>
    import("node:fs/promises").then((fs) =>
      fs.readFile(path.join(projectRoot, "infra/main.bicep"), "utf8"),
    );

  it("never names the secret - not as a parameter, an env entry or a vault reference", async () => {
    const bicep = await readBicep();
    expect(bicep).not.toContain("PHB_PLATFORM_CO_REVIEW_APP_SECRET");
    expect(bicep).not.toMatch(/param \w*[cC]oReview\w*[sS]ecret/);
    expect(bicep).not.toMatch(/CO-REVIEW/);
  });

  it("carries the three identifiers as plain values from parameters that default to blank", async () => {
    const bicep = await readBicep();

    for (const [name, param] of [
      ["PHB_PLATFORM_CO_REVIEW_APP_TENANT_ID", "coReviewAppTenantId"],
      ["PHB_PLATFORM_CO_REVIEW_APP_CLIENT_ID", "coReviewAppClientId"],
      ["CO_REVIEW_SHAREPOINT_FOLDER", "coReviewSharePointFolder"],
    ]) {
      expect(bicep).toMatch(new RegExp(`name:\\s*'${name}'[\\s\\S]{0,60}value:\\s*${param}\\b`));
      expect(bicep).not.toMatch(new RegExp(`name:\\s*'${name}'[\\s\\S]{0,60}secretRef:`));
      expect(bicep).toMatch(new RegExp(`param ${param} string = ''`));
    }
  });

  it("spells each variable's name in lib/env.ts, and the reader is lazy so a missing value cannot stop the boot", async () => {
    const env = await import("@/lib/env");
    expect(env.CO_REVIEW_APP_TENANT_ID_VAR).toBe("PHB_PLATFORM_CO_REVIEW_APP_TENANT_ID");
    expect(env.CO_REVIEW_APP_CLIENT_ID_VAR).toBe("PHB_PLATFORM_CO_REVIEW_APP_CLIENT_ID");
    expect(env.CO_REVIEW_APP_SECRET_VAR).toBe("PHB_PLATFORM_CO_REVIEW_APP_SECRET");
    expect(env.CO_REVIEW_SHAREPOINT_FOLDER_VAR).toBe("CO_REVIEW_SHAREPOINT_FOLDER");

    // The suite leaves them unset; the reader reports that rather than throwing,
    // which is what lets the app boot with the Needs Review tab unconfigured.
    const result = env.readReviewEnv();
    expect(result.present).toBe(false);
  });

  it("ships the three parameters blank in the example file, beside the CIP ones", async () => {
    const example = JSON.parse(
      await import("node:fs/promises").then((fs) =>
        fs.readFile(path.join(projectRoot, "infra/main.parameters.example.json"), "utf8"),
      ),
    ) as { parameters: Record<string, { value: unknown }> };

    expect(example.parameters.coReviewAppTenantId?.value).toBe("");
    expect(example.parameters.coReviewAppClientId?.value).toBe("");
    expect(example.parameters.coReviewSharePointFolder?.value).toBe("");
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

describe("the two deploy paths cannot diverge on the image or the port", () => {
  /**
   * Two things write the container app and each owns half of it. The deploy
   * workflow runs `az containerapp update --image`, which sets the image and
   * keeps everything else from the running revision; a template deployment
   * sets everything else and - because a deployment replaces the whole
   * resource - the image too. `containerImage` used to default to the public
   * placeholder and the parameters file never set it, so a routine template
   * redeploy on 2026-10-13 put the placeholder back: revision 0000053, a
   * hello-world listening on :80 under probes for :3000, ActivationFailed.
   * Every port setting on that revision was 3000 and correct; the image was
   * the drift. Nothing local can run a deployment, so this reads the files.
   */
  const readFile = async (relative: string) =>
    import("node:fs/promises").then((fs) =>
      fs.readFile(path.join(projectRoot, relative), "utf8"),
    );
  const PLACEHOLDER = "mcr.microsoft.com/k8se/quickstart";

  it("requires containerImage - no default, so a forgotten image fails at validation", async () => {
    const bicep = await readFile("infra/main.bicep");
    expect(bicep).toMatch(/^param containerImage string\s*$/m);
    expect(bicep).not.toMatch(/^param containerImage string\s*=/m);
  });

  it("names the placeholder image only in comments, never as a value", async () => {
    const bicep = await readFile("infra/main.bicep");
    const codeLines = bicep
      .split(/\r?\n/)
      .filter((line) => !line.trim().startsWith("//"));
    expect(codeLines.join("\n")).not.toContain(PLACEHOLDER);
    expect(bicep).toContain(PLACEHOLDER); // the comment that says why it is gone
  });

  it("keeps containerImage out of the example parameters, where it would go stale", async () => {
    const example = JSON.parse(await readFile("infra/main.parameters.example.json")) as {
      parameters: Record<string, unknown>;
    };
    expect(Object.keys(example.parameters)).not.toContain("containerImage");
    expect(JSON.stringify(example.parameters)).not.toContain(PLACEHOLDER);
  });

  it("agrees with the Dockerfile on the port: PORT, EXPOSE and containerPort are one number", async () => {
    const bicep = await readFile("infra/main.bicep");
    const dockerfile = await readFile("Dockerfile");
    const runtime = dockerfile.slice(dockerfile.lastIndexOf("FROM "));

    const containerPort = bicep.match(/^param containerPort int = (\d+)\s*$/m)?.[1];
    const envPort = runtime.match(/\bPORT=(\d+)/)?.[1];
    const exposed = runtime.match(/^EXPOSE (\d+)\s*$/m)?.[1];

    expect(containerPort).toBeDefined();
    expect(envPort).toBe(containerPort);
    expect(exposed).toBe(containerPort);
  });

  it("feeds the ingress target port and both probes from containerPort, and sets no PORT env of its own", async () => {
    const bicep = await readFile("infra/main.bicep");
    const app = bicep.slice(bicep.indexOf("resource containerApp "));

    expect(app).toMatch(/targetPort:\s*containerPort\b/);
    const probePorts = app.match(/httpGet:\s*\{[^}]*port:\s*(\w+)/g) ?? [];
    expect(probePorts).toHaveLength(2);
    for (const probe of probePorts) {
      expect(probe).toMatch(/port:\s*containerPort\b/);
    }
    // The image decides where the process listens (Dockerfile ENV PORT). A
    // PORT or HOSTNAME entry here would be carried forward by the workflow
    // path and the Dockerfile would stop being the one place it is decided.
    expect(app).not.toMatch(/name:\s*'PORT'/);
    expect(app).not.toMatch(/name:\s*'HOSTNAME'/);
  });

  it("probes the same path the workflow and CI verify against", async () => {
    const bicep = await readFile("infra/main.bicep");
    const workflow = await readFile(".github/workflows/deploy.yml");
    const ci = await readFile(".github/workflows/ci.yml");

    const probePaths = [...bicep.matchAll(/httpGet:\s*\{\s*path:\s*'([^']+)'/g)].map((m) => m[1]);
    expect(probePaths).toEqual(["/api/health", "/api/health"]);
    expect(workflow).toContain('"https://$URL/api/health"');
    // CI boots the image with no port mapping and curls the Dockerfile's port.
    const dockerfile = await readFile("Dockerfile");
    const envPort = dockerfile.match(/\bPORT=(\d+)/)?.[1];
    expect(ci).toContain(`http://localhost:${envPort}/api/health`);
  });

  it("lets the workflow set the image and nothing else that shapes a revision", async () => {
    const workflow = await readFile(".github/workflows/deploy.yml");
    const deploy = workflow
      .split("az containerapp update")[1]
      ?.split("- name:")[0];
    expect(deploy).toBeDefined();
    expect(deploy).toContain("--image");
    // Anything else here would be a second source of truth for a setting the
    // template owns, and the two would drift the other way.
    for (const flag of [
      "--target-port",
      "--set-env-vars",
      "--env-vars",
      "--replace-env-vars",
      "--cpu",
      "--memory",
      "--min-replicas",
      "--max-replicas",
      "--secrets",
    ]) {
      expect(deploy, flag).not.toContain(flag);
    }
  });
});

describe("the two secure parameters are optional, and omitted means unchanged (2026-10-21)", () => {
  /**
   * Until 2026-10-21 `postgresAdminPassword` and `authSecret` were required on
   * every template deployment and whatever was typed was SET: on 2026-10-13 a
   * value mistyped at the prompt rotated the production administrator
   * password, and the running app kept the old one in DATABASE-URL until the
   * next revision picked the new URL up. Now each defaults to empty, and empty
   * means "leave it alone": the server keeps its password, DATABASE-URL keeps
   * its version, AUTH-SECRET keeps its version. Non-empty behaves as before.
   *
   * Pinned both ways. Omitted: the password is ABSENT from the server request
   * (not sent empty, not sent null) and neither secret resource is deployed.
   * Supplied: the value reaches the server and both secrets exactly as it
   * always did. Nothing local can run a deployment, so this reads the
   * template, and where `az` is installed it reads the ARM it compiles to.
   */
  const readFile = async (relative: string) =>
    import("node:fs/promises").then((fs) =>
      fs.readFile(path.join(projectRoot, relative), "utf8"),
    );
  const codeOnly = (bicep: string) =>
    bicep
      .split(/\r?\n/)
      .filter((line) => !line.trim().startsWith("//"))
      .join("\n");

  it("defaults both secure parameters to empty, so a deployment can omit them", async () => {
    const bicep = await readFile("infra/main.bicep");
    // @secure() stays: Azure logs neither the value nor the fact it was empty.
    expect(bicep).toMatch(
      /@secure\(\)\s*\n@description\([^\n]*\)\s*\nparam postgresAdminPassword string = ''\s*$/m,
    );
    expect(bicep).toMatch(
      /@secure\(\)\s*\n@description\([^\n]*\)\s*\nparam authSecret string = ''\s*$/m,
    );
  });

  it("decides 'supplied' once for each, from trim(), so a stray space is not a password", async () => {
    const code = codeOnly(await readFile("infra/main.bicep"));
    expect(code).toMatch(/^var setPostgresAdminPassword = !empty\(trim\(postgresAdminPassword\)\)\s*$/m);
    expect(code).toMatch(/^var setAuthSecret = !empty\(trim\(authSecret\)\)\s*$/m);
  });

  it("omitted: the password is absent from the server request, never sent empty or null", async () => {
    const code = codeOnly(await readFile("infra/main.bicep"));
    // The only way the property enters the request is a spread that is an
    // empty object when nothing was supplied.
    expect(code).toMatch(
      /\.\.\.\(setPostgresAdminPassword \? \{ administratorLoginPassword: postgresAdminPassword \} : \{\}\)/,
    );
    // Never as a bare property, which would SET whatever the parameter holds -
    // the pre-2026-10-21 shape and the one that rotated production.
    expect(code).not.toMatch(/^\s*administratorLoginPassword:/m);
    // And never "set it to nothing" as a stand-in for "leave it".
    expect(code).not.toMatch(/administratorLoginPassword:\s*(null|''|"")/);
  });

  it("omitted: neither vault secret is written - both resources are conditional on their own parameter", async () => {
    const code = codeOnly(await readFile("infra/main.bicep"));
    expect(code).toMatch(
      /^resource databaseUrlSecret 'Microsoft\.KeyVault\/vaults\/secrets@[\d-]+' = if \(setPostgresAdminPassword\) \{/m,
    );
    expect(code).toMatch(
      /^resource authSecretSecret 'Microsoft\.KeyVault\/vaults\/secrets@[\d-]+' = if \(setAuthSecret\) \{/m,
    );
    // DATABASE-URL embeds the password, so it follows the PASSWORD's
    // condition, not the session secret's and not its own.
    expect(code).not.toMatch(/resource databaseUrlSecret[^\n]*if \(setAuthSecret\)/);
  });

  it("supplied: the value still reaches the server and both secrets, exactly as before", async () => {
    const code = codeOnly(await readFile("infra/main.bicep"));
    const linesUsing = (identifier: RegExp) =>
      code.split("\n").filter((line) => identifier.test(line) && !/^\s*param /.test(line));

    // Every use of the password outside its declaration is one of three
    // things: the decision variable, the server's conditional property, or
    // the connection URL the DATABASE-URL secret is written from.
    const passwordUses = linesUsing(/\bpostgresAdminPassword\b/);
    expect(passwordUses.length).toBe(3);
    for (const line of passwordUses) {
      expect(line).toMatch(
        /^var setPostgresAdminPassword = |\.\.\.\(setPostgresAdminPassword \? \{ administratorLoginPassword: postgresAdminPassword \}|^var databaseUrl = .*uriComponent\(postgresAdminPassword\)/,
      );
    }
    expect(code).toMatch(/value:\s*databaseUrl\s*\n/);

    // And every use of the session secret is the decision variable or the
    // AUTH-SECRET value. (`authSecretSecret` and `setAuthSecret` are other
    // identifiers; the word boundary keeps them out.)
    const secretUses = linesUsing(/\bauthSecret\b/);
    expect(secretUses.length).toBe(2);
    for (const line of secretUses) {
      expect(line).toMatch(/^var setAuthSecret = |^\s*value:\s*authSecret\s*$/);
    }
  });

  it("keeps the container app and the worker job depending on both secrets, so a first deployment writes them before anything references them", async () => {
    const code = codeOnly(await readFile("infra/main.bicep"));
    // The reference is through the resource's symbolic name, which is what
    // gives Bicep the dependency. ARM ignores a dependency on a resource
    // whose condition is false, so an omitted secret does not block a redeploy.
    const databaseUrlRefs = code.match(/secrets\/\$\{databaseUrlSecret\.name\}/g) ?? [];
    expect(databaseUrlRefs.length).toBe(3); // the app, the CIP worker job, the backup job
    expect(code).toMatch(/secrets\/\$\{authSecretSecret\.name\}/);
  });

  it("keeps both out of the example parameters, where a value would be committed", async () => {
    const example = JSON.parse(await readFile("infra/main.parameters.example.json")) as {
      parameters: Record<string, unknown>;
    };
    expect(Object.keys(example.parameters)).not.toContain("postgresAdminPassword");
    expect(Object.keys(example.parameters)).not.toContain("authSecret");
  });

  it("tells the deployer the routine command omits them, and the README says what omitting does", async () => {
    const readme = await readFile("infra/README.md");
    const deploySection = readme.split("## Deploy")[1]?.split("\n## ")[0] ?? "";
    const routineCommand = deploySection.split("```bash")[1]?.split("```")[0] ?? "";
    expect(routineCommand).toContain("az deployment group create");
    expect(routineCommand).toContain("containerImage=");
    expect(routineCommand).not.toContain("postgresAdminPassword");
    expect(routineCommand).not.toContain("authSecret");
    expect(deploySection).toMatch(/omit\w*[^\n]*(unchanged|untouched|leave)/i);
  });

  // The compiled check. `az bicep build` is what CI runs; here it proves the
  // ARM says what the source says, where the CLI is installed.
  const az = spawnSync("az", ["bicep", "version"], { encoding: "utf8", shell: true });
  const azAvailable = az.status === 0;

  it.skipIf(!azAvailable)(
    "compiles to ARM where both parameters default to empty, the password is only inside the conditional, and both secrets carry a condition",
    () => {
      const build = spawnSync(
        "az",
        ["bicep", "build", "--file", "infra/main.bicep", "--stdout"],
        { cwd: projectRoot, encoding: "utf8", shell: true, maxBuffer: 16 * 1024 * 1024 },
      );
      expect(build.status, build.stderr).toBe(0);
      const arm = JSON.parse(build.stdout.replace(/^﻿/, "")) as {
        parameters: Record<string, { type: string; defaultValue?: unknown }>;
        variables: Record<string, unknown>;
        resources: Record<string, ArmResource> | ArmResource[];
      };
      interface ArmResource {
        type: string;
        name: string;
        condition?: string;
        properties?: unknown;
      }

      expect(arm.parameters.postgresAdminPassword).toMatchObject({ type: "securestring", defaultValue: "" });
      expect(arm.parameters.authSecret).toMatchObject({ type: "securestring", defaultValue: "" });
      expect(arm.variables.setPostgresAdminPassword).toBe(
        "[not(empty(trim(parameters('postgresAdminPassword'))))]",
      );
      expect(arm.variables.setAuthSecret).toBe("[not(empty(trim(parameters('authSecret'))))]");

      const resources = Array.isArray(arm.resources) ? arm.resources : Object.values(arm.resources);
      const server = resources.find((r) => r.type === "Microsoft.DBforPostgreSQL/flexibleServers");
      expect(server).toBeDefined();
      const serverProperties = JSON.stringify(server?.properties);
      // Exactly one mention, and it is inside the `if(...)`.
      expect(serverProperties.match(/administratorLoginPassword/g)?.length).toBe(1);
      expect(serverProperties).toContain(
        "if(variables('setPostgresAdminPassword'), createObject('administratorLoginPassword', parameters('postgresAdminPassword')), createObject())",
      );

      const secretCondition = (name: string) =>
        resources.find(
          (r) => r.type === "Microsoft.KeyVault/vaults/secrets" && r.name.includes(`'${name}'`),
        )?.condition;
      expect(secretCondition("DATABASE-URL")).toBe("[variables('setPostgresAdminPassword')]");
      expect(secretCondition("AUTH-SECRET")).toBe("[variables('setAuthSecret')]");
    },
  );
});

describe("the custom domain lives in the template, and a routine redeploy cannot drop it (2026-10-21)", () => {
  /**
   * `platform.phb1899.com` is attached to the container app through
   * `infra/main.bicep` - a custom hostname beside the app's own address, with
   * a free managed certificate issued on the environment - rather than by a
   * one-off `az containerapp hostname bind`, because a template deployment
   * replaces the whole container app and would silently remove a hostname the
   * template did not know about (the placeholder-image lesson, applied to a
   * hostname).
   *
   * Two things that must stay true. The certificate depends on the app (Azure
   * will not issue for a hostname no app carries) and the app names the
   * certificate, so the id is built with resourceId() rather than a symbolic
   * reference - a reference would be a cycle. And the binding defaults to
   * TRUE: the first deployment passes customDomainBound=false on the command
   * line to add the hostname and issue the certificate, and no later
   * deployment needs to remember anything, because the parameters file never
   * carries the binding. Nothing local can run a deployment, so this reads
   * the files, and the compiled ARM where `az` is installed.
   */
  const readFile = async (relative: string) =>
    import("node:fs/promises").then((fs) =>
      fs.readFile(path.join(projectRoot, relative), "utf8"),
    );
  const codeOnly = (bicep: string) =>
    bicep
      .split(/\r?\n/)
      .filter((line) => !line.trim().startsWith("//"))
      .join("\n");
  const resourceBody = (bicep: string, symbolicName: string) => {
    const start = bicep.indexOf(`resource ${symbolicName} `);
    expect(start, `resource ${symbolicName}`).toBeGreaterThan(-1);
    const rest = bicep.slice(start);
    const next = rest.slice(1).search(/^(resource|module|output|param|var) /m);
    return next === -1 ? rest : rest.slice(0, next + 1);
  };

  it("takes the hostname as a parameter that defaults to empty, so a template without one deploys as before", async () => {
    const bicep = await readFile("infra/main.bicep");
    expect(bicep).toMatch(/^param customDomainName string = ''\s*$/m);
  });

  it("defaults the binding to true, so the parameters file never has to carry it and a redeploy keeps the certificate bound", async () => {
    const bicep = await readFile("infra/main.bicep");
    expect(bicep).toMatch(/^param customDomainBound bool = true\s*$/m);
  });

  it("ships the hostname in the example parameters, blank, and never the binding", async () => {
    const example = JSON.parse(await readFile("infra/main.parameters.example.json")) as {
      parameters: Record<string, { value: unknown }>;
    };
    expect(example.parameters.customDomainName).toEqual({ value: "" });
    expect(Object.keys(example.parameters)).not.toContain("customDomainBound");
  });

  it("puts the hostname on the ingress in one of two states: bound to the certificate, or merely present", async () => {
    const bicep = codeOnly(await readFile("infra/main.bicep"));
    expect(resourceBody(bicep, "containerApp")).toMatch(/customDomains:\s*customDomains/);
    const variable = bicep.slice(bicep.indexOf("var customDomains ="));
    expect(variable).toContain("bindingType: 'SniEnabled'");
    expect(variable).toContain("certificateId: managedCertificateId");
    expect(variable).toContain("bindingType: 'Disabled'");
    // Unbound: the key is absent, not empty. Both states keep the hostname.
    const unbound = variable.slice(variable.indexOf("bindingType: 'Disabled'"));
    expect(unbound.split("\n").slice(0, 3).join("\n")).not.toContain("certificateId");
  });

  it("names the certificate by resourceId(), never by a symbolic reference, because the certificate depends on the app", async () => {
    const bicep = codeOnly(await readFile("infra/main.bicep"));
    expect(bicep).toMatch(
      /^var managedCertificateId = resourceId\('Microsoft\.App\/managedEnvironments\/managedCertificates', managedEnvironmentName, managedCertificateName\)\s*$/m,
    );
    expect(resourceBody(bicep, "containerApp")).not.toMatch(/\bmanagedCertificate\b/);
    const certificate = resourceBody(bicep, "managedCertificate");
    expect(certificate).toMatch(/= if \(hasCustomDomain\)/);
    expect(certificate).toContain("domainControlValidation: 'CNAME'");
    expect(certificate).toMatch(/dependsOn:\s*\[\s*containerApp\s*\]/);
  });

  it("leaves authUrl and the SSO redirect URI on the app's own address - sign-in moves only when the redirect URI is added", async () => {
    const bicep = codeOnly(await readFile("infra/main.bicep"));
    expect(bicep).toMatch(/name: 'AUTH_URL'\s*\n\s*value: authUrl\s*$/m);
    expect(bicep).not.toMatch(/authUrl[^\n]*customDomain/);
    expect(bicep).toMatch(
      /^output ssoRedirectUri string = 'https:\/\/\$\{containerApp\.properties\.configuration\.ingress\.fqdn\}\/api\/auth\/callback\/microsoft-entra-id'\s*$/m,
    );
    expect(bicep).toMatch(/^output customDomainSsoRedirectUri string = /m);
  });

  it("is untouched by the deploy workflow, which sets the image and nothing else", async () => {
    const workflow = await readFile(".github/workflows/deploy.yml");
    expect(workflow).not.toMatch(/hostname|customDomain|certificate/i);
  });

  it("documents the two passes: the first with customDomainBound=false on the command line, every later one without it", async () => {
    const readme = await readFile("infra/README.md");
    const section = readme.split("## Custom domain")[1]?.split("\n## ")[0] ?? "";
    expect(section).toContain("customDomainBound=false");
    expect(section.match(/customDomainBound=false/g)?.length).toBe(1);
    expect(section).toMatch(/asuid\./);
    expect(section).toMatch(/CNAME/);
  });

  const az = spawnSync("az", ["bicep", "version"], { encoding: "utf8", shell: true });
  const azAvailable = az.status === 0;

  it.skipIf(!azAvailable)(
    "compiles to ARM where the app does not depend on the certificate, the certificate depends on the app, and the binding defaults to true",
    () => {
      const build = spawnSync(
        "az",
        ["bicep", "build", "--file", "infra/main.bicep", "--stdout"],
        { cwd: projectRoot, encoding: "utf8", shell: true, maxBuffer: 16 * 1024 * 1024 },
      );
      expect(build.status, build.stderr).toBe(0);
      const arm = JSON.parse(build.stdout.replace(/^﻿/, "")) as {
        parameters: Record<string, { type: string; defaultValue?: unknown }>;
        variables: Record<string, unknown>;
        resources: Record<string, ArmResource> | ArmResource[];
      };
      interface ArmResource {
        type: string;
        name: string;
        condition?: string;
        dependsOn?: string[];
        properties?: { configuration?: { ingress?: { customDomains?: unknown } } };
      }
      expect(arm.parameters.customDomainName).toMatchObject({ type: "string", defaultValue: "" });
      expect(arm.parameters.customDomainBound).toMatchObject({ type: "bool", defaultValue: true });

      const resources = Array.isArray(arm.resources) ? arm.resources : Object.values(arm.resources);
      const app = resources.find((r) => r.type === "Microsoft.App/containerApps");
      const certificate = resources.find(
        (r) => r.type === "Microsoft.App/managedEnvironments/managedCertificates",
      );
      expect(app).toBeDefined();
      expect(certificate).toBeDefined();
      expect(app?.properties?.configuration?.ingress?.customDomains).toBe("[variables('customDomains')]");
      expect(JSON.stringify(app?.dependsOn)).not.toContain("managedCertificates");
      expect(JSON.stringify(certificate?.dependsOn)).toContain("Microsoft.App/containerApps");
      expect(certificate?.condition).toBe("[variables('hasCustomDomain')]");
      expect(arm.variables.customDomains).toContain("'bindingType', 'SniEnabled', 'certificateId'");
      expect(arm.variables.customDomains).toContain("'bindingType', 'Disabled'");
    },
  );
});

describe("the nightly database backup is conditional, identity-only, and holds no secret on a command line (2026-10-21)", () => {
  /**
   * A storage account, a container, a lifecycle rule, one role assignment
   * and a scheduled Container Apps Job, all behind enableDbBackup - off by
   * default, like enableCipWorker and for the same reason (the job names an
   * image that has to be built into the registry first). The job reads
   * DATABASE-URL by reference, runs the script with no argument, and the
   * script hands the password to pg_dump through libpq's environment -
   * tests/db-backup-script.test.ts holds the script side.
   */
  const readFile = async (relative: string) =>
    import("node:fs/promises").then((fs) =>
      fs.readFile(path.join(projectRoot, relative), "utf8"),
    );
  const codeOnly = (bicep: string) =>
    bicep
      .split(/\r?\n/)
      .filter((line) => !line.trim().startsWith("//"))
      .join("\n");
  /**
   * The dbBackupJob resource block, from its declaration to the next
   * declaration or section rule. `codeOnly` has already dropped the comment
   * lines, so the section rule is not there to stop at; until the Part E
   * shadow jobs were added after this one (2026-10-30) the block ran to the
   * end of the file and happened to hold only this job.
   */
  const jobBlock = (bicep: string) => {
    const start = bicep.indexOf("resource dbBackupJob ");
    expect(start).toBeGreaterThan(-1);
    const rest = bicep.slice(start + 1);
    const ends = [rest.indexOf("\nresource "), rest.indexOf("\nvar "), rest.indexOf("\n// ----")].filter((i) => i > 0);
    return rest.slice(0, ends.length ? Math.min(...ends) : undefined);
  };
  /** One resource block, from its declaration to the next declaration. */
  const resourceBlock = (bicep: string, name: string) => {
    const start = bicep.indexOf(`resource ${name} `);
    expect(start, name).toBeGreaterThan(-1);
    const rest = bicep.slice(start + 1);
    return rest.slice(0, rest.indexOf("\nresource "));
  };

  const BACKUP_RESOURCES = [
    "backupStorage",
    "backupBlobService",
    "dumpsContainer",
    "backupLifecycle",
    "backupBlobWrite",
    "dbBackupJob",
  ];

  it("is off by default, and every one of its resources is conditional on the same parameter", async () => {
    const code = codeOnly(await readFile("infra/main.bicep"));
    expect(code).toMatch(/^param enableDbBackup bool = false$/m);
    for (const name of BACKUP_RESOURCES) {
      expect(code, name).toMatch(new RegExp(`^resource ${name} '[^']+' = if \\(enableDbBackup\\) \\{$`, "m"));
    }
    // Exactly these, and the two outputs read them only through a ternary -
    // a conditional resource read unconditionally fails the deployment when
    // the flag is off.
    const conditional = code.match(/^resource (\w+) '[^']+' = if \(enableDbBackup\)/gm) ?? [];
    expect(conditional.length).toBe(BACKUP_RESOURCES.length);
    const outputs = code.split("\n").filter((line) => /^output (dbBackupJobName|dbBackupStorageAccountName)/.test(line));
    expect(outputs.length).toBe(2);
    for (const line of outputs) expect(line).toMatch(/= enableDbBackup \? \w+\.name : ''$/);
  });

  it("runs on a UTC schedule, once, with a bounded run and one retry", async () => {
    const code = codeOnly(await readFile("infra/main.bicep"));
    const job = jobBlock(code);
    expect(job).toMatch(/triggerType: 'Schedule'/);
    expect(job).toMatch(/cronExpression: dbBackupCron/);
    expect(job).toMatch(/parallelism: 1/);
    expect(job).toMatch(/replicaCompletionCount: 1/);
    expect(job).toMatch(/replicaTimeout: \d+/);
    expect(job).toMatch(/replicaRetryLimit: 1/);
    expect(code).toMatch(/^param dbBackupCron string = '30 8 \* \* \*'$/m);
    // The description says what that is in the building's zone, both halves of the year.
    expect(await readFile("infra/main.bicep")).toMatch(/08:30 UTC[^\n]*03:30[^\n]*04:30/);
  });

  it("reads DATABASE-URL by reference and nothing secret as a value; the command is the script and no argument", async () => {
    const code = codeOnly(await readFile("infra/main.bicep"));
    const job = jobBlock(code);
    expect(job).toMatch(/name:\s*'DATABASE_URL'\s*\n\s*secretRef:\s*'database-url'/);
    expect(job).toMatch(/keyVaultUrl: '\$\{keyVault\.properties\.vaultUri\}secrets\/\$\{databaseUrlSecret\.name\}'/);
    // The one secret the job holds.
    expect((job.match(/keyVaultUrl:/g) ?? []).length).toBe(1);
    // Every plain value is configuration by name; none is a secret, a
    // password or a connection string.
    const values = job.split("\n").filter((line) => /^\s*value:/.test(line));
    expect(values.length).toBe(3);
    for (const line of values) {
      expect(line).not.toMatch(/password|secret|databaseUrl|authSecret|Password/);
    }
    const names = [...job.matchAll(/name:\s*'([A-Z_]+)'\s*\n\s*value:/g)].map((m) => m[1]);
    expect(names.sort()).toEqual(["AZURE_CLIENT_ID", "BACKUP_BLOB_ENDPOINT", "BACKUP_CONTAINER"]);
    // One element: the script. An argument would be on every execution's record.
    const command = job.match(/command: \[([^\]]*)\]/)?.[1] ?? "";
    expect(command.trim().split(/\s+/)).toEqual(["'/usr/local/bin/phb-db-backup'"]);
    // The template never names a backup role, password or URL of its own:
    // the administrator's connection is the choice, and the reason is in the
    // section comment.
    expect(code).not.toMatch(/param \w*[bB]ackup\w*(Password|Secret|Url) /);
    expect(await readFile("infra/main.bicep")).toMatch(/Why the administrator's connection and not a backup role of its own/);
  });

  it("names the image by the server's major, from a variable the deploy cannot drift", async () => {
    const code = codeOnly(await readFile("infra/main.bicep"));
    expect(code).toMatch(/^var dbBackupImage = '\$\{registry\.properties\.loginServer\}\/db-backup:pg\$\{postgresVersion\}'$/m);
    expect(jobBlock(code)).toMatch(/image: dbBackupImage/);
    expect(code).not.toMatch(/param dbBackupImage/);
  });

  it("uploads as the identity, to one container, with no shared key anywhere", async () => {
    const code = codeOnly(await readFile("infra/main.bicep"));
    // Storage Blob Data Contributor, by GUID, scoped to the container.
    expect(code).toMatch(/^var storageBlobDataContributorRoleId = 'ba92f5b4-2d11-453d-a403-e96b0029c9fe'$/m);
    const assignment = resourceBlock(code, "backupBlobWrite");
    expect(assignment).toMatch(/scope: dumpsContainer/);
    expect(assignment).toMatch(/principalId: identity\.properties\.principalId/);
    expect(assignment).toMatch(/storageBlobDataContributorRoleId/);
    // The account refuses key-based access, public blobs and plain HTTP.
    const account = resourceBlock(code, "backupStorage");
    expect(account).toMatch(/allowSharedKeyAccess: false/);
    expect(account).toMatch(/allowBlobPublicAccess: false/);
    expect(account).toMatch(/supportsHttpsTrafficOnly: true/);
    expect(account).toMatch(/minimumTlsVersion: 'TLS1_2'/);
    expect(account).toMatch(/name: 'Standard_(LRS|ZRS|GRS|GZRS|RAGRS|RAGZRS)'/);
    // No key is read anywhere: listKeys on the account would be a credential.
    expect(code).not.toMatch(/backupStorage\.listKeys/);
    // The job depends on the assignment, so a first run cannot race it.
    expect(jobBlock(code)).toMatch(/dependsOn: \[\s*acrPull\s*keyVaultRead\s*backupBlobWrite\s*\]/);
  });

  it("deletes a dump after the retention period, from a parameter that defaults to 90 days", async () => {
    const code = codeOnly(await readFile("infra/main.bicep"));
    expect(code).toMatch(/^param dbBackupRetentionDays int = 90$/m);
    const policy = resourceBlock(code, "backupLifecycle");
    expect(policy).toMatch(/daysAfterModificationGreaterThan: dbBackupRetentionDays/);
    expect(policy).toMatch(/prefixMatch: \[\s*'\$\{dbBackupContainerName\}\/'\s*\]/);
    expect(policy).toMatch(/blobTypes: \[\s*'blockBlob'\s*\]/);
  });

  it("makes the server's own point-in-time retention a parameter, defaulting to the live value", async () => {
    const code = codeOnly(await readFile("infra/main.bicep"));
    expect(code).toMatch(/^param postgresBackupRetentionDays int = 7$/m);
    expect(code).toMatch(/backupRetentionDays: postgresBackupRetentionDays/);
    expect(code).not.toMatch(/backupRetentionDays: \d/);
  });

  it("ships the flag off in the example parameters, and the retention beside the other server settings", async () => {
    const example = JSON.parse(await readFile("infra/main.parameters.example.json")) as {
      parameters: Record<string, { value: unknown }>;
    };
    expect(example.parameters.enableDbBackup?.value).toBe(false);
    expect(example.parameters.postgresBackupRetentionDays?.value).toBe(7);
  });

  it("is documented: the README lists what is created, and the runbook has the restore steps", async () => {
    const readme = await readFile("infra/README.md");
    const created = readme.split("## What gets created")[1]?.split("\n## ")[0] ?? "";
    expect(created).toMatch(/enableDbBackup/);
    expect(created).toMatch(/Storage Blob Data Contributor/);
    const runbook = await readFile("runbook.md");
    const section = runbook.split("\n## Nightly database backup")[1]?.split("\n## ")[0] ?? "";
    expect(section.length).toBeGreaterThan(2000);
    expect(section).toMatch(/az containerapp job execution list/);
    expect(section).toMatch(/pg_restore/);
    expect(section).toMatch(/--auth-mode login/);
    expect(section).toMatch(/enableDbBackup/);
    expect(section).toMatch(/per month/i);
  });

  const az = spawnSync("az", ["bicep", "version"], { encoding: "utf8", shell: true });
  const azAvailable = az.status === 0;

  it.skipIf(!azAvailable)(
    "compiles to ARM where every backup resource carries the condition, the job is scheduled, and its command is one element",
    () => {
      const build = spawnSync(
        "az",
        ["bicep", "build", "--file", "infra/main.bicep", "--stdout"],
        { cwd: projectRoot, encoding: "utf8", shell: true, maxBuffer: 16 * 1024 * 1024 },
      );
      expect(build.status, build.stderr).toBe(0);
      interface ArmResource {
        type: string;
        name: string;
        condition?: string;
        properties?: {
          configuration?: { triggerType?: string; secrets?: Array<{ name: string; keyVaultUrl?: string; value?: string }> };
          template?: { containers?: Array<{ command?: string[]; env?: Array<{ name: string; value?: string; secretRef?: string }> }> };
          allowSharedKeyAccess?: boolean;
        };
        sku?: { name: string };
      }
      const arm = JSON.parse(build.stdout.replace(/^﻿/, "")) as {
        parameters: Record<string, { type: string; defaultValue?: unknown }>;
        resources: Record<string, ArmResource> | ArmResource[];
      };
      expect(arm.parameters.enableDbBackup).toMatchObject({ type: "bool", defaultValue: false });
      expect(arm.parameters.postgresBackupRetentionDays).toMatchObject({ type: "int", defaultValue: 7 });

      const resources = Array.isArray(arm.resources) ? arm.resources : Object.values(arm.resources);
      const ofType = (type: string) => resources.filter((r) => r.type === type);
      for (const type of [
        "Microsoft.Storage/storageAccounts",
        "Microsoft.Storage/storageAccounts/blobServices",
        "Microsoft.Storage/storageAccounts/blobServices/containers",
        "Microsoft.Storage/storageAccounts/managementPolicies",
      ]) {
        const found = ofType(type);
        expect(found.length, type).toBe(1);
        expect(found[0]!.condition, type).toBe("[parameters('enableDbBackup')]");
      }
      const account = ofType("Microsoft.Storage/storageAccounts")[0]!;
      expect(account.properties?.allowSharedKeyAccess).toBe(false);
      expect(account.sku?.name).toMatch(/^Standard_/);

      // Bicep hoists the GUID into an ARM variable, so the assignment names
      // the variable; the source test above holds the variable to the GUID.
      const blobRole = ofType("Microsoft.Authorization/roleAssignments").filter((r) =>
        /ba92f5b4-2d11-453d-a403-e96b0029c9fe|storageBlobDataContributorRoleId/.test(JSON.stringify(r)),
      );
      expect(blobRole.length).toBe(1);
      expect(blobRole[0]!.condition).toBe("[parameters('enableDbBackup')]");

      const jobs = ofType("Microsoft.App/jobs");
      const backup = jobs.find((j) => j.name.includes("db-backup"));
      expect(backup).toBeDefined();
      expect(backup!.condition).toBe("[parameters('enableDbBackup')]");
      expect(backup!.properties?.configuration?.triggerType).toBe("Schedule");
      const container = backup!.properties?.template?.containers?.[0];
      expect(container?.command).toEqual(["/usr/local/bin/phb-db-backup"]);
      const env = container?.env ?? [];
      expect(env.find((e) => e.name === "DATABASE_URL")).toEqual({ name: "DATABASE_URL", secretRef: "database-url" });
      for (const e of env) {
        if (e.value !== undefined) expect(e.value, e.name).not.toMatch(/[pP]assword|[sS]ecret/);
      }
      // The job's one secret is a vault reference, never an inline value.
      for (const s of backup!.properties?.configuration?.secrets ?? []) {
        expect(s.keyVaultUrl, s.name).toBeDefined();
        expect(s.value, s.name).toBeUndefined();
      }
    },
  );
});

describe("the Phase 12 Part E shadow run: three jobs behind one flag, two identities, one secret (2026-10-30)", () => {
  /**
   * docs/phase-12-part-e-plan.md section 5, decided in section 14: the shadow
   * run's jobs live in the Bicep behind enableCoShadow - off by default, like
   * enableDbBackup and for the same reason (the image has to be in the
   * registry first). The feed reads the LIVE tree as the reader app and
   * writes the COPY as the engine app; only the feed and the by-hand classify
   * job carry the Change Orders Anthropic key, by reference; the collector
   * makes no model call and carries no secret. The two live tracker
   * workbooks are configuration here and spelled nowhere in code.
   */
  const readFile = async (relative: string) =>
    import("node:fs/promises").then((fs) =>
      fs.readFile(path.join(projectRoot, relative), "utf8"),
    );
  const codeOnly = (bicep: string) =>
    bicep
      .split(/\r?\n/)
      .filter((line) => !line.trim().startsWith("//"))
      .join("\n");
  /** One resource block, from its declaration to the next declaration or section rule. */
  const resourceBlock = (bicep: string, name: string) => {
    const start = bicep.indexOf(`resource ${name} `);
    expect(start, name).toBeGreaterThan(-1);
    const rest = bicep.slice(start + 1);
    const ends = [rest.indexOf("\nresource "), rest.indexOf("\n// ----")].filter((i) => i > 0);
    return rest.slice(0, Math.min(...ends));
  };

  const SHADOW_JOBS = ["coShadowFeedJob", "coShadowCollectJob", "coClassifyJob"];

  it("is off by default, and all three jobs are conditional on the same parameter with ternary outputs", async () => {
    const code = codeOnly(await readFile("infra/main.bicep"));
    expect(code).toMatch(/^param enableCoShadow bool = false$/m);
    for (const name of SHADOW_JOBS) {
      expect(code, name).toMatch(new RegExp(`^resource ${name} '[^']+' = if \\(enableCoShadow\\) \\{$`, "m"));
    }
    const conditional = code.match(/^resource (\w+) '[^']+' = if \(enableCoShadow\)/gm) ?? [];
    expect(conditional.length).toBe(SHADOW_JOBS.length);
    const outputs = code.split("\n").filter((line) => /^output (coShadowFeedJobName|coShadowCollectJobName|coClassifyJobName)/.test(line));
    expect(outputs.length).toBe(3);
    for (const line of outputs) expect(line).toMatch(/= enableCoShadow \? \w+\.name : ''$/);
  });

  it("schedules the feed and the collector in UTC with a bounded run and no retry, and keeps the classify job manual", async () => {
    const code = codeOnly(await readFile("infra/main.bicep"));
    const feed = resourceBlock(code, "coShadowFeedJob");
    expect(feed).toMatch(/triggerType: 'Schedule'/);
    expect(feed).toMatch(/cronExpression: coShadowFeedCron/);
    expect(feed).toMatch(/parallelism: 1/);
    expect(feed).toMatch(/replicaCompletionCount: 1/);
    expect(feed).toMatch(/replicaRetryLimit: 0/);
    // shorter than the hour between feed runs, so two can never overlap
    const feedTimeout = Number(/replicaTimeout: (\d+)/.exec(feed)?.[1]);
    expect(feedTimeout).toBeGreaterThan(0);
    expect(feedTimeout).toBeLessThan(3600);
    const collect = resourceBlock(code, "coShadowCollectJob");
    expect(collect).toMatch(/triggerType: 'Schedule'/);
    expect(collect).toMatch(/cronExpression: coShadowCollectCron/);
    expect(collect).toMatch(/replicaRetryLimit: 0/);
    const classify = resourceBlock(code, "coClassifyJob");
    expect(classify).toMatch(/triggerType: 'Manual'/);
    expect(classify).toMatch(/manualTriggerConfig/);
    // the defaults are the window's crons, in UTC, under Eastern standard time
    expect(code).toMatch(/^param coShadowFeedCron string = '45 11-22 \* \* 1-5'$/m);
    expect(code).toMatch(/^param coShadowCollectCron string = '0 16,21,23 \* \* 1-5'$/m);
    expect(code).toMatch(/^param coShadowSnapshotHoursUtc string = '12,17'$/m);
    // and the template says what those are in New York, both halves of the year
    expect(await readFile("infra/main.bicep")).toMatch(/13:00 and 18:00 UTC/);
  });

  it("gives the feed and the classify job the Change Orders key by reference, and the collector no secret at all", async () => {
    const code = codeOnly(await readFile("infra/main.bicep"));
    for (const name of ["coShadowFeedJob", "coClassifyJob"]) {
      const job = resourceBlock(code, name);
      expect(job, name).toMatch(/name:\s*'CO_ANTHROPIC_API_KEY'\s*\n\s*secretRef:\s*'co-anthropic-api-key'/);
      expect(job, name).toMatch(/keyVaultUrl: '\$\{keyVault\.properties\.vaultUri\}secrets\/\$\{coAnthropicApiKeySecretName\}'/);
      expect(job, name).not.toMatch(/ANTHROPIC_API_KEY'\s*\n\s*value:/);
      expect(job, name).not.toMatch(/anthropicApiKeySecretName\b(?!.*co)/);
    }
    const collect = resourceBlock(code, "coShadowCollectJob");
    expect(collect).not.toMatch(/secrets:/);
    expect(collect).not.toMatch(/ANTHROPIC/);
    expect(collect).not.toMatch(/secretRef/);
    // never the BAS key: the shadow is the change-order module's
    for (const name of SHADOW_JOBS) expect(resourceBlock(code, name)).not.toMatch(/\banthropicApiKeySecretName\b/);
  });

  it("names both identities as plain values and never a workbook path in code", async () => {
    const code = codeOnly(await readFile("infra/main.bicep"));
    const common = code.slice(code.indexOf("var coShadowCommonEnv"), code.indexOf("resource coShadowFeedJob"));
    expect(common).toMatch(/name: 'CO_GRAPH_APP_CLIENT_ID'\s*\n\s*value: coEngineAppClientId/);
    expect(common).toMatch(/name: 'CO_READER_APP_CLIENT_ID'\s*\n\s*value: coReaderAppClientId/);
    expect(common).toMatch(/name: 'CO_GRAPH_AUTH'\s*\n\s*value: 'federated'/);
    expect(common).toMatch(/name: 'CO_READER_GRAPH_AUTH'\s*\n\s*value: 'federated'/);
    expect(common).toMatch(/name: 'CO_SHADOW_ROOT'\s*\n\s*value: coShadowRoot/);
    // the two workbooks are parameters with blank defaults; the words never appear as values
    expect(code).toMatch(/^param coShadowBidTrackerPath string = ''$/m);
    expect(code).toMatch(/^param coShadowMasterPath string = ''$/m);
    expect(code).not.toMatch(/Bid Tracker\.xlsx/);
    expect(code).not.toMatch(/Managment/);
    // the reader's id reaches only the feed and the collector through the common env; the engine app's id too
    const feed = resourceBlock(code, "coShadowFeedJob");
    expect(feed).toMatch(/CO_SHADOW_BID_TRACKER_PATH/);
    expect(feed).toMatch(/CO_SHADOW_SNAPSHOT_HOURS_UTC/);
    expect(feed).toMatch(/CO_CLASSIFIER_MODEL_STEPS/);
  });

  it("runs the three scripts by path with no argument, from one image that is a required parameter when the flag is on", async () => {
    const code = codeOnly(await readFile("infra/main.bicep"));
    expect(code).toMatch(/^param coEngineImage string = ''$/m);
    expect(code).not.toMatch(/phb-co-engine:[a-z0-9-]+'/);
    const scripts: Record<string, string> = {
      coShadowFeedJob: "/app/infra/shadow-feed.sh",
      coShadowCollectJob: "/app/infra/shadow-collect.sh",
      coClassifyJob: "/app/infra/classify-job.sh",
    };
    for (const [name, script] of Object.entries(scripts)) {
      const job = resourceBlock(code, name);
      expect(job, name).toMatch(/image: coEngineImage/);
      const command = /command: \[([\s\S]*?)\]/.exec(job)?.[1] ?? "";
      expect(command.trim().split(/\s+/), name).toEqual(["'sh'", `'${script}'`]);
    }
  });

  it("ships the flag off and the nine plain values blank in the example parameters", async () => {
    const example = JSON.parse(await readFile("infra/main.parameters.example.json")) as {
      parameters: Record<string, { value: unknown }>;
    };
    expect(example.parameters.enableCoShadow?.value).toBe(false);
    for (const name of ["coEngineImage", "coEngineAppClientId", "coReaderAppClientId", "coGraphTenantId",
      "coShadowDriveId", "coShadowRoot", "coShadowBidTrackerPath", "coShadowMasterPath"]) {
      expect(example.parameters[name]?.value, name).toBe("");
    }
  });

  it("is documented where the other optional pieces are", async () => {
    expect(await readFile("infra/README.md")).toMatch(/enableCoShadow/);
    expect(await readFile("runbook.md")).toMatch(/enableCoShadow/);
  });

  describe("in the compiled ARM, when az is installed", () => {
    const arm = (() => {
      const r = spawnSync("az", ["bicep", "build", "--file", "infra/main.bicep", "--stdout"], {
        cwd: projectRoot,
        encoding: "utf8",
        shell: true,
      });
      if (r.status !== 0 || !r.stdout) return null;
      return JSON.parse(r.stdout) as {
        parameters: Record<string, { type: string; defaultValue?: unknown }>;
        resources: Array<{ type: string; name: string; condition?: string; properties?: Record<string, unknown> }>;
      };
    })();
    const itIfArm = arm ? it : it.skip;

    itIfArm("every shadow job is conditional on enableCoShadow, and the flag defaults to false", () => {
      expect(arm!.parameters.enableCoShadow).toMatchObject({ type: "bool", defaultValue: false });
      const jobs = arm!.resources.filter((r) => r.type === "Microsoft.App/jobs" && /co-shadow|co-classify/.test(r.name));
      expect(jobs.length).toBe(3);
      for (const j of jobs) expect(j.condition, j.name).toBe("[parameters('enableCoShadow')]");
    });

    itIfArm("the collector carries no secret and the feed's one secret is the Change Orders key", () => {
      const byName = (part: string) => arm!.resources.find((r) => r.type === "Microsoft.App/jobs" && r.name.includes(part));
      const collect = byName("co-shadow-collect")!;
      const cfg = (collect.properties as { configuration?: { secrets?: unknown[] } }).configuration ?? {};
      expect(cfg.secrets ?? []).toEqual([]);
      const feed = byName("co-shadow-feed")!;
      const fcfg = (feed.properties as { configuration: { secrets: Array<{ name: string; keyVaultUrl: string }> } }).configuration;
      expect(fcfg.secrets.map((s) => s.name)).toEqual(["co-anthropic-api-key"]);
      // the compiled reference names the variable, which holds CO-ANTHROPIC-API-KEY
      expect(fcfg.secrets[0]!.keyVaultUrl).toMatch(/coAnthropicApiKeySecretName/);
    });
  });
});
