import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The nightly backup's script and image (infra/db-backup/), held to the
 * properties the job is built for. The template side - the conditional
 * resources, the schedule, the role assignment - is in
 * tests/deploy-guards.test.ts; the whole thing running for real, against a
 * throwaway database and a fake of the two Azure endpoints, is
 * `npm run db:backup:verify`.
 *
 * What is pinned here and why:
 *
 *   - the password is never on a command line. pg_dump is run with no
 *     connection argument (libpq reads PGHOST/PGUSER/PGPASSWORD from the
 *     environment), and every curl header that carries a credential goes in
 *     through a config file on stdin, never as a `-H` argument;
 *   - the pg_dump major is the server's major: the Dockerfile's PG_MAJOR
 *     default equals the template's postgresVersion default, and the
 *     template names the image by that number;
 *   - the URL parser - the one piece of logic in the script - is run through
 *     the real bash with the characters that break naive URL handling.
 */

const projectRoot = path.resolve(process.cwd());
const read = (relative: string) => readFile(path.join(projectRoot, relative), "utf8");

const SCRIPT = "infra/db-backup/backup.sh";
const DOCKERFILE = "infra/db-backup/Dockerfile";

/** The script with comment lines removed, so a prohibited token in a comment is not a false positive and one in code is not hidden. */
const codeOnly = (text: string) =>
  text
    .split("\n")
    .filter((line) => !line.trim().startsWith("#"))
    .join("\n");

describe("the backup script never puts a credential on a command line", () => {
  it("runs pg_dump with no connection argument at all", async () => {
    const code = codeOnly(await read(SCRIPT));
    // Invocations: pg_dump followed by an option. The log and fail lines that
    // merely name pg_dump are not.
    const dumpLines = code.split("\n").filter((line) => /\bpg_dump\s+-/.test(line) && !/--version/.test(line));
    expect(dumpLines.length).toBe(1);
    const [line] = dumpLines;
    expect(line).toMatch(/pg_dump --format=custom --file="\$file"/);
    for (const forbidden of ["--dbname", " -d ", "-h ", "--host", "-U ", "--username", "DATABASE_URL", "PGPASSWORD", "postgresql://", "--password"]) {
      expect(line, `pg_dump line must not carry ${forbidden}`).not.toContain(forbidden);
    }
  });

  it("moves the URL into libpq's own variables and unsets it before pg_dump runs", async () => {
    const code = codeOnly(await read(SCRIPT));
    for (const variable of ["PGHOST", "PGPORT", "PGUSER", "PGPASSWORD", "PGDATABASE", "PGSSLMODE"]) {
      expect(code).toMatch(new RegExp(`^\\s*${variable}=`, "m"));
    }
    const unsetAt = code.indexOf("unset DATABASE_URL");
    const dumpAt = code.search(/pg_dump --format=custom/);
    expect(unsetAt).toBeGreaterThan(-1);
    expect(dumpAt).toBeGreaterThan(unsetAt);
  });

  it("passes the identity header and the bearer token to curl on stdin, never as a -H argument", async () => {
    const code = codeOnly(await read(SCRIPT));
    // Every curl invocation reads a config from stdin.
    const curls = code.split("\n").filter((line) => /\bcurl\b/.test(line));
    expect(curls.length).toBe(3); // token, PUT, HEAD
    for (const line of curls) expect(line).toContain("--config -");
    // The credentials appear only inside the printf that feeds that stdin.
    for (const line of code.split("\n")) {
      if (/--header|(^|\s)-H\s/.test(line)) {
        expect(line, line).not.toMatch(/Authorization|IDENTITY_HEADER|\$token/i);
      }
    }
    expect(code).toMatch(/printf 'header = "X-IDENTITY-HEADER: %s"\\n' "\$IDENTITY_HEADER" \|/);
    expect(code).toMatch(/printf 'header = "Authorization: Bearer %s"\\n' "\$token" \|/);
    // And the token is never echoed.
    expect(code).not.toMatch(/log [^\n]*\$token/);
    expect(code).not.toMatch(/set -x/);
  });

  it("fails closed: strict mode, every step ends in fail, and the partial file goes with it", async () => {
    const code = codeOnly(await read(SCRIPT));
    expect(code).toMatch(/^set -euo pipefail$/m);
    expect(code).toMatch(/^fail\(\) \{ log "FAILED: \$\*"; exit 1; \}$/m);
    for (const step of [
      "is not set",
      "is not a postgresql:// URL",
      "carries no password",
      "pg_dump exited non-zero",
      "pg_dump wrote an empty file",
      "pg_restore cannot read the archive",
      "holds no _prisma_migrations table",
      "the identity endpoint",
      "returned no access_token",
      "upload returned HTTP",
      "the blob is not there after the upload",
      "the dump was",
    ]) {
      expect(code, step).toContain(step);
    }
    // No partial dump survives a failure after the file exists: one EXIT trap
    // removes it, set after the file is named and before pg_dump writes it.
    const trapAt = code.indexOf(`trap "rm -f '$file' '$out' '$head'" EXIT`);
    const dumpAt = code.indexOf("pg_dump --format=custom");
    expect(trapAt).toBeGreaterThan(-1);
    expect(dumpAt).toBeGreaterThan(trapAt);
    // And an exit set -e forces without a fail() still says so.
    expect(code).toMatch(/^trap 'log "FAILED: unexpected error at line \$LINENO[^']*' ERR$/m);
  });

  it("reads the archive back and checks the upload the way the service does", async () => {
    const code = codeOnly(await read(SCRIPT));
    expect(code).toContain('pg_restore --list "$file"');
    expect(code).toContain("TABLE DATA public _prisma_migrations");
    expect(code).toContain('--header "Content-MD5: ${md5}"');
    expect(code).toContain('--header "x-ms-blob-type: BlockBlob"');
    expect(code).toMatch(/\[ "\$length" != "\$bytes" \]/);
    // Nothing hangs for the replica timeout on a dead endpoint.
    for (const line of code.split("\n").filter((l) => /\bcurl\b/.test(l))) {
      expect(line).toMatch(/--connect-timeout \d+ --max-time \d+/);
    }
  });

  it("names the dump by its UTC time and says so", async () => {
    const code = codeOnly(await read(SCRIPT));
    expect(code).toContain('stamp="$(date -u +%Y-%m-%d_%H%MZ)"');
    expect(code).toContain('name="${PGDATABASE}_${stamp}.dump"');
  });

  it("has LF line endings, because a CR after the shebang is 'bad interpreter' in the container", async () => {
    const raw = await read(SCRIPT);
    expect(raw.includes("\r")).toBe(false);
    expect(raw.startsWith("#!/usr/bin/env bash\n")).toBe(true);
    const attributes = await read(".gitattributes");
    expect(attributes).toMatch(/^\*\.sh text eol=lf$/m);
  });
});

describe("the image is the server's major, and the template agrees", () => {
  it("pins PG_MAJOR to the template's postgresVersion default and builds from the official image", async () => {
    const dockerfile = await read(DOCKERFILE);
    const bicep = await read("infra/main.bicep");
    const major = dockerfile.match(/^ARG PG_MAJOR=(\d+)$/m)?.[1];
    expect(major).toBeDefined();
    expect(bicep).toContain(`param postgresVersion string = '${major}'`);
    expect(dockerfile).toMatch(/^FROM postgres:\$\{PG_MAJOR\}-alpine$/m);
    // The template names the image by the same number, as a variable - not a
    // parameter that a redeploy could set to something else.
    expect(bicep).toContain("var dbBackupImage = '${registry.properties.loginServer}/db-backup:pg${postgresVersion}'");
    expect(bicep).not.toMatch(/param dbBackupImage/);
  });

  it("installs what the script uses, runs unprivileged, and the entrypoint is the template's command", async () => {
    const dockerfile = await read(DOCKERFILE);
    const bicep = await read("infra/main.bicep");
    expect(dockerfile).toMatch(/^RUN apk add --no-cache bash curl openssl$/m);
    expect(dockerfile).toMatch(/^USER postgres$/m);
    expect(dockerfile).toMatch(/^COPY backup\.sh \/usr\/local\/bin\/phb-db-backup$/m);
    expect(dockerfile).toMatch(/^ENTRYPOINT \["\/usr\/local\/bin\/phb-db-backup"\]$/m);
    expect(bicep).toMatch(/command: \[\s*'\/usr\/local\/bin\/phb-db-backup'\s*\]/);
  });
});

// --- the parser, through the real bash --------------------------------------

const bash = spawnSync("bash", ["--version"], { encoding: "utf8" });
const haveBash = bash.status === 0;

function parse(url: string | undefined): { status: number | null; fields: string[]; output: string } {
  const program = [
    `source ${SCRIPT}`,
    `parse_database_url "$1"`,
    `printf '%s\\n' "$PGHOST" "$PGPORT" "$PGUSER" "$PGPASSWORD" "$PGDATABASE" "$PGSSLMODE"`,
  ].join("; ");
  const result = spawnSync("bash", ["-c", program, "_", url ?? ""], { cwd: projectRoot, encoding: "utf8" });
  return {
    status: result.status,
    fields: result.stdout.replace(/\n$/, "").split("\n"),
    output: result.stdout + result.stderr,
  };
}

describe.skipIf(!haveBash)("parse_database_url, in bash", () => {
  /**
   * RFC 3986 encoding, which is what Bicep's uriComponent() writes into
   * DATABASE-URL: everything but A-Z a-z 0-9 - . _ ~ is %XX. JavaScript's
   * encodeURIComponent leaves ! ' ( ) * bare, and a bare quote in an argument
   * is also what the Windows bash on the PATH would swallow at the command
   * line, so the test encodes exactly as the template does.
   */
  const rfc3986 = (s: string) =>
    encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

  it("decodes a password made of every character that breaks naive URL handling", () => {
    const password = "p@ss%word:x/y?z#1 +\\q'\"!*()";
    const url = `postgresql://postgres:${rfc3986(password)}@phbplat-prod-pg-abc123.postgres.database.azure.com:5432/phb_platform?sslmode=require`;
    const { status, fields } = parse(url);
    expect(status).toBe(0);
    expect(fields).toEqual([
      "phbplat-prod-pg-abc123.postgres.database.azure.com",
      "5432",
      "postgres",
      password,
      "phb_platform",
      "require",
    ]);
  });

  it("defaults the port to 5432 and sslmode to require, and takes postgres:// too", () => {
    const { status, fields } = parse("postgres://u:pw@db.example/mydb");
    expect(status).toBe(0);
    expect(fields).toEqual(["db.example", "5432", "u", "pw", "mydb", "require"]);
  });

  it("reads sslmode from the query string among other keys", () => {
    const { status, fields } = parse("postgresql://u:pw@h:6543/d?schema=public&sslmode=disable&x=1");
    expect(status).toBe(0);
    expect(fields[1]).toBe("6543");
    expect(fields[5]).toBe("disable");
  });

  it("refuses what it cannot parse rather than guessing", () => {
    for (const [url, reason] of [
      ["mysql://u:pw@h/d", "is not a postgresql:// URL"],
      ["postgresql://u@h/d", "carries no password"],
      ["postgresql://u:pw@h", "names no database"],
      ["postgresql://u:pw@h:abc/d", "has a non-numeric port"],
      ["postgresql://u:@h/d", "has an empty password"],
      ["postgresql://:pw@h/d", "has an empty user"],
    ] as const) {
      const { status, output } = parse(url);
      expect(status, url).toBe(1);
      expect(output, url).toContain(`FAILED: DATABASE_URL ${reason}`);
      // The refusal never prints the URL it refused.
      expect(output).not.toContain("pw");
    }
  });
});
