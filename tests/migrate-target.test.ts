import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  DEV_ONLY_COMMANDS,
  LIVE_DATA_TABLE,
  MigrateTargetRefused,
  countLiveRows,
  describeTarget,
  isSameDatabase,
  prismaCommand,
  resolveMigrateTarget,
  targetIdentity,
  type LiveRowCounter,
} from "@/prisma/migrate-target";

/**
 * `prisma migrate dev` must not be able to reach the database that holds the
 * collected BAS readings - locally that is DATABASE_URL, and the readings are
 * the one thing in it that cannot be re-fetched from anywhere.
 *
 * Three layers, because each catches something the others cannot:
 *
 *   - the routing and every refusal, unit tested with a stubbed row counter;
 *   - the real row counter against real databases, including one that does not
 *     exist;
 *   - the real `npx prisma` CLI, as a subprocess, with an environment arranged
 *     the way each accident would arrange it. The thing under test is what
 *     happens when somebody types the command, so the command is what runs.
 *
 * The subprocess tests refuse before Prisma opens a connection, so none of
 * them needs - or gets - a shadow database, and none touches the test database.
 */

const projectRoot = path.resolve(process.cwd());
const PRISMA_CLI = path.join(projectRoot, "node_modules", "prisma", "build", "index.js");

/** A loopback port nothing listens on. Never dialled if a guard runs first. */
const NOWHERE = "postgresql://guard:guard@127.0.0.1:1/should_never_connect";
const NOWHERE_TOO = "postgresql://guard:guard@127.0.0.1:1/should_never_connect_either";
const REMOTE =
  "postgresql://admin:sup3r-s3cret@example-pg.postgres.database.azure.com:5432/phb_platform";

/**
 * A database on the same server as the test database, holding one row in a
 * table called bas_readings and nothing else. The guard checks the table by
 * name and counts rows; it does not need the real schema, and creating a bare
 * table is what keeps this hermetic - no fixture chain, nothing left in the
 * test database.
 */
const PROBE_DATABASE = "zz_migrate_guard_probe";
const MISSING_DATABASE = "zz_migrate_guard_does_not_exist";

const testUrl = process.env.TEST_DATABASE_URL?.trim() ?? "";

function siblingDatabaseUrl(database: string): string {
  const url = new URL(testUrl);
  url.pathname = `/${database}`;
  url.search = "";
  return url.toString();
}

const probeUrl = siblingDatabaseUrl(PROBE_DATABASE);
const missingUrl = siblingDatabaseUrl(MISSING_DATABASE);

async function withAdmin<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const admin = new Client({ connectionString: siblingDatabaseUrl("postgres") });
  await admin.connect();
  try {
    return await fn(admin);
  } finally {
    await admin.end();
  }
}

beforeAll(async () => {
  await withAdmin(async (admin) => {
    await admin.query(`DROP DATABASE IF EXISTS "${PROBE_DATABASE}"`);
    await admin.query(`CREATE DATABASE "${PROBE_DATABASE}"`);
  });
  const probe = new Client({ connectionString: probeUrl });
  await probe.connect();
  try {
    await probe.query(`CREATE TABLE ${LIVE_DATA_TABLE} (id integer)`);
    await probe.query(`INSERT INTO ${LIVE_DATA_TABLE} VALUES (1)`);
  } finally {
    await probe.end();
  }
});

afterAll(async () => {
  await withAdmin((admin) => admin.query(`DROP DATABASE IF EXISTS "${PROBE_DATABASE}"`));
});

/** A counter that records what it was asked and answers a fixed value. */
function stubCounter(answer: number | null): LiveRowCounter & { calls: string[] } {
  const calls: string[] = [];
  const counter = (async (url: string) => {
    calls.push(url);
    return answer;
  }) as LiveRowCounter & { calls: string[] };
  counter.calls = calls;
  return counter;
}

async function refusal(promise: Promise<unknown>): Promise<MigrateTargetRefused> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(MigrateTargetRefused);
    return error as MigrateTargetRefused;
  }
  throw new Error("expected a refusal and got a result");
}

describe("identifying the Prisma command", () => {
  it("reads the first two words and ignores flags wherever they sit", () => {
    expect(prismaCommand(["migrate", "dev", "--name", "x"])).toBe("migrate dev");
    expect(prismaCommand(["migrate", "reset", "--force"])).toBe("migrate reset");
    expect(prismaCommand(["db", "push", "--accept-data-loss"])).toBe("db push");
    expect(prismaCommand(["--config", "other.ts", "migrate", "status"])).toBe("migrate status");
    expect(prismaCommand(["--config=other.ts", "migrate", "deploy"])).toBe("migrate deploy");
    expect(prismaCommand(["generate"])).toBe("generate");
    expect(prismaCommand(["--version"])).toBeNull();
    expect(prismaCommand([])).toBeNull();
  });

  it("gates exactly the commands that can drop tables or reset a database", () => {
    expect([...DEV_ONLY_COMMANDS].sort()).toEqual(["db push", "migrate dev", "migrate reset"]);
  });
});

describe("comparing two connection strings", () => {
  it("compares host, port and database rather than the raw string", () => {
    expect(isSameDatabase("postgresql://a:b@localhost:5432/x", "postgresql://c:d@LOCALHOST/x?schema=public")).toBe(true);
    expect(isSameDatabase("postgresql://a:b@localhost:5432/x", "postgresql://a:b@localhost:5432/x/")).toBe(false);
    expect(isSameDatabase("postgresql://a:b@localhost:5432/x", "postgresql://a:b@localhost:5433/x")).toBe(false);
    expect(isSameDatabase("postgresql://a:b@localhost:5432/x", "postgresql://a:b@localhost:5432/y")).toBe(false);
    expect(isSameDatabase("postgresql://a:b@localhost:5432/x", "postgresql://a:b@127.0.0.1:5432/x")).toBe(false);
  });

  it("fails closed on anything unreadable", () => {
    expect(isSameDatabase("not-a-url", "not-a-url")).toBe(false);
    expect(isSameDatabase(undefined, undefined)).toBe(false);
    expect(isSameDatabase("postgresql://u:p@localhost:5432/", "postgresql://u:p@localhost:5432/")).toBe(false);
    expect(targetIdentity("postgresql://u:p@localhost:5432/")).toBeNull();
  });

  it("describes a target without its password", () => {
    expect(describeTarget("postgresql://admin:sup3r-s3cret@db.example.com/prod")).toBe("db.example.com:5432/prod");
    expect(describeTarget("garbage")).not.toContain("garbage");
  });
});

describe("routing: everything that is not dev-only goes to DATABASE_URL", () => {
  const env = { DATABASE_URL: "postgresql://u:p@localhost:5432/live" };

  it.each([["migrate", "deploy"], ["migrate", "status"], ["migrate", "resolve"], ["migrate", "diff"], ["generate"], ["validate"], ["db", "execute"]])(
    "%s %s",
    async (...argv: string[]) => {
      const counter = stubCounter(99);
      const target = await resolveMigrateTarget({ argv, env, countLiveRows: counter });
      expect(target.source).toBe("DATABASE_URL");
      expect(target.url).toBe(env.DATABASE_URL);
      expect(counter.calls).toEqual([]);
    },
  );

  it("works with no MIGRATE_DEV_DATABASE_URL and even with no DATABASE_URL, because generate needs neither", async () => {
    const target = await resolveMigrateTarget({ argv: ["generate"], env: {}, countLiveRows: stubCounter(99) });
    expect(target).toEqual({ url: "", source: "DATABASE_URL", command: "generate" });
  });
});

describe("routing: the dev-only commands", () => {
  const dev = "postgresql://u:p@localhost:5432/phb_platform_dev";
  const live = "postgresql://u:p@localhost:5432/phb_platform";
  const test = "postgresql://u:p@localhost:5432/phb_platform_test";

  it.each([...DEV_ONLY_COMMANDS].map((c) => c.split(" ")))("%s %s goes to MIGRATE_DEV_DATABASE_URL", async (...argv: string[]) => {
    const counter = stubCounter(0);
    const target = await resolveMigrateTarget({
      argv,
      env: { DATABASE_URL: live, TEST_DATABASE_URL: test, MIGRATE_DEV_DATABASE_URL: dev },
      countLiveRows: counter,
    });
    expect(target.source).toBe("MIGRATE_DEV_DATABASE_URL");
    expect(target.url).toBe(dev);
    expect(counter.calls).toEqual([dev]);
  });

  it("refuses when the variable is unset, and does not fall back to DATABASE_URL", async () => {
    const counter = stubCounter(0);
    const error = await refusal(
      resolveMigrateTarget({ argv: ["migrate", "dev"], env: { DATABASE_URL: live }, countLiveRows: counter }),
    );
    expect(error.message).toContain("MIGRATE_DEV_DATABASE_URL is not set");
    expect(error.message).toContain("does not fall back to DATABASE_URL");
    expect(counter.calls).toEqual([]);
  });

  it("treats blank as unset", async () => {
    const error = await refusal(
      resolveMigrateTarget({ argv: ["migrate", "dev"], env: { MIGRATE_DEV_DATABASE_URL: "   " }, countLiveRows: stubCounter(0) }),
    );
    expect(error.message).toContain("is not set");
  });

  it("refuses a remote host before connecting, naming the host and not the password", async () => {
    const counter = stubCounter(0);
    const error = await refusal(
      resolveMigrateTarget({ argv: ["migrate", "reset"], env: { MIGRATE_DEV_DATABASE_URL: REMOTE }, countLiveRows: counter }),
    );
    expect(error.message).toContain("example-pg.postgres.database.azure.com");
    expect(error.message).toContain("not at localhost");
    expect(error.message).not.toContain("sup3r-s3cret");
    expect(error.message).not.toContain("postgresql://");
    expect(counter.calls).toEqual([]);
  });

  it.each([["DATABASE_URL"], ["TEST_DATABASE_URL"]])(
    "refuses when it names the same database as %s, however the string is written",
    async (variable) => {
      const counter = stubCounter(0);
      const error = await refusal(
        resolveMigrateTarget({
          argv: ["migrate", "dev"],
          env: {
            [variable]: "postgresql://other:pw@LOCALHOST/phb_platform?schema=public",
            MIGRATE_DEV_DATABASE_URL: live,
          },
          countLiveRows: counter,
        }),
      );
      expect(error.message).toContain(`MIGRATE_DEV_DATABASE_URL and ${variable} both name localhost:5432/phb_platform`);
      expect(counter.calls).toEqual([]);
    },
  );

  it("refuses a database holding bas_readings rows, and says how many", async () => {
    const error = await refusal(
      resolveMigrateTarget({
        argv: ["migrate", "dev"],
        env: { DATABASE_URL: live, MIGRATE_DEV_DATABASE_URL: dev },
        countLiveRows: stubCounter(44_750),
      }),
    );
    expect(error.message).toContain("localhost:5432/phb_platform_dev holds 44,750 bas_readings rows");
    expect(error.message).toContain("live building data");
  });

  it("gets the grammar right for one row", async () => {
    const error = await refusal(
      resolveMigrateTarget({ argv: ["db", "push"], env: { MIGRATE_DEV_DATABASE_URL: dev }, countLiveRows: stubCounter(1) }),
    );
    expect(error.message).toContain("holds 1 bas_readings row.");
  });

  it("lets a database that does not exist yet through - migrate dev creates it", async () => {
    const target = await resolveMigrateTarget({
      argv: ["migrate", "dev"],
      env: { MIGRATE_DEV_DATABASE_URL: dev },
      countLiveRows: stubCounter(null),
    });
    expect(target.source).toBe("MIGRATE_DEV_DATABASE_URL");
  });

  it("propagates a counter that could not connect - unreachable is not the same as empty", async () => {
    const failing: LiveRowCounter = async () => {
      throw new MigrateTargetRefused("Could not connect");
    };
    const error = await refusal(
      resolveMigrateTarget({ argv: ["migrate", "dev"], env: { MIGRATE_DEV_DATABASE_URL: dev }, countLiveRows: failing }),
    );
    expect(error.message).toContain("Could not connect");
  });
});

describe("the real row counter", () => {
  it("counts rows in a database that has the table", async () => {
    expect(await countLiveRows(probeUrl)).toBe(1);
  });

  it("reports zero for a database without the table", async () => {
    // The maintenance database has no bas_readings and never will.
    expect(await countLiveRows(siblingDatabaseUrl("postgres"))).toBe(0);
  });

  it("reports null for a database that does not exist", async () => {
    expect(await countLiveRows(missingUrl)).toBeNull();
  });

  it("refuses rather than assumes when the server is unreachable", async () => {
    const error = await refusal(countLiveRows(NOWHERE));
    expect(error.message).toContain("Could not connect to 127.0.0.1:1/should_never_connect");
    expect(error.message).not.toContain("guard:guard");
  });
});

interface RunResult {
  status: number | null;
  output: string;
}

/**
 * Runs the real CLI. The environment is inherited - tests/setup.ts has already
 * pointed DATABASE_URL at the test database - and then overridden per case.
 * prisma.config.ts loads .env.local with dotenv, which never overrides a
 * variable that is already set, so an empty string here means "unset" and a
 * deliberate value here beats whatever the developer's file says.
 */
function runPrisma(args: string[], env: Record<string, string>): RunResult {
  // The CLI's own entry point under node, rather than `npx prisma` through a
  // shell: no shell quoting, and both streams come back on success as well as
  // failure - the `[prisma.config]` line is written to stderr on purpose.
  const result = spawnSync(process.execPath, [PRISMA_CLI, ...args], {
    cwd: projectRoot,
    env: { ...process.env, ...env },
    encoding: "utf8",
    stdio: "pipe",
  });
  return { status: result.status, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

/** What a run that got as far as Prisma's own work would have printed. */
function expectNeverReachedPrisma(result: RunResult): void {
  expect(result.status).not.toBe(0);
  expect(result.output).toContain("refused");
  expect(result.output).not.toContain("ECONNREFUSED");
  expect(result.output).not.toContain("Applying migration");
  expect(result.output).not.toContain("Datasource \"db\"");
}

describe("the real CLI: `prisma migrate dev` cannot reach a live database", () => {
  it("refuses when MIGRATE_DEV_DATABASE_URL is unset - the situation before this guard existed", () => {
    const result = runPrisma(["migrate", "dev", "--skip-generate", "--skip-seed"], {
      MIGRATE_DEV_DATABASE_URL: "",
    });
    expectNeverReachedPrisma(result);
    expect(result.output).toContain("MIGRATE_DEV_DATABASE_URL is not set");
  });

  it("refuses when it is the same database as DATABASE_URL", () => {
    const result = runPrisma(["migrate", "dev", "--skip-generate", "--skip-seed"], {
      DATABASE_URL: NOWHERE,
      MIGRATE_DEV_DATABASE_URL: NOWHERE,
    });
    expectNeverReachedPrisma(result);
    expect(result.output).toContain("MIGRATE_DEV_DATABASE_URL and DATABASE_URL both name");
  });

  it("refuses a database that holds bas_readings rows, by looking", () => {
    const result = runPrisma(["migrate", "dev", "--skip-generate", "--skip-seed"], {
      DATABASE_URL: NOWHERE,
      TEST_DATABASE_URL: NOWHERE_TOO,
      MIGRATE_DEV_DATABASE_URL: probeUrl,
    });
    expectNeverReachedPrisma(result);
    expect(result.output).toContain(`${PROBE_DATABASE} holds 1 bas_readings row`);
  });

  it("refuses `migrate reset --force` the same way - --force skips Prisma's prompt, not this", () => {
    const result = runPrisma(["migrate", "reset", "--force", "--skip-generate", "--skip-seed"], {
      DATABASE_URL: NOWHERE,
      TEST_DATABASE_URL: NOWHERE_TOO,
      MIGRATE_DEV_DATABASE_URL: probeUrl,
    });
    expectNeverReachedPrisma(result);
    expect(result.output).toContain("`prisma migrate reset` refused");
    expect(result.output).toContain("holds 1 bas_readings row");
  });

  it("refuses a remote host without printing the credential", () => {
    const result = runPrisma(["migrate", "dev", "--skip-generate", "--skip-seed"], {
      MIGRATE_DEV_DATABASE_URL: REMOTE,
    });
    expectNeverReachedPrisma(result);
    expect(result.output).toContain("example-pg.postgres.database.azure.com");
    expect(result.output).not.toContain("sup3r-s3cret");
  });

  it("still routes `migrate status` to DATABASE_URL, and says so, with MIGRATE_DEV_DATABASE_URL unset", () => {
    // The gate is on the destructive commands only. Reading status must keep
    // working for somebody who has never heard of the new variable.
    const result = runPrisma(["migrate", "status"], { MIGRATE_DEV_DATABASE_URL: "" });
    expect(result.output).toContain("[prisma.config] migrate status ->");
    expect(result.output).toContain("(DATABASE_URL)");
    expect(result.output).toContain(targetIdentity(testUrl)?.database ?? "unreachable");
    expect(result.status).toBe(0);
  });
});

describe("the wiring that makes the guard hold", () => {
  it("prisma.config.ts imports only from ./prisma/, because that is all the Docker deps stage copies", async () => {
    const source = await readFile(path.join(projectRoot, "prisma.config.ts"), "utf8");
    const relativeImports = [...source.matchAll(/from\s+"(\.[^"]*)"/g)].map((m) => m[1]);
    expect(relativeImports.length).toBeGreaterThan(0);
    for (const specifier of relativeImports) {
      expect(specifier, specifier).toMatch(/^\.\/prisma\//);
    }

    const dockerfile = await readFile(path.join(projectRoot, "Dockerfile"), "utf8");
    expect(dockerfile).toContain("COPY prisma ./prisma");
    expect(dockerfile).toContain("COPY prisma.config.ts ./");
  });

  it("prisma.config.ts hands the seed the same database it just migrated", async () => {
    // migrate reset runs `tsx prisma/seed.ts`, which reads DATABASE_URL. Without
    // this line a reset of the dev database would seed the live one.
    const source = await readFile(path.join(projectRoot, "prisma.config.ts"), "utf8");
    expect(source).toContain("process.env.DATABASE_URL = target.url");
  });

  it("CI and deploy run migrate deploy and never a dev-only command", async () => {
    for (const workflow of ["ci.yml", "deploy.yml"]) {
      const source = await readFile(path.join(projectRoot, ".github/workflows", workflow), "utf8");
      for (const command of DEV_ONLY_COMMANDS) {
        expect(source, `${workflow} runs ${command}`).not.toContain(`prisma ${command}`);
      }
    }
    const deploy = await readFile(path.join(projectRoot, ".github/workflows/deploy.yml"), "utf8");
    expect(deploy).toContain("npx prisma migrate deploy");
  });

  it(".env.example documents the variable", async () => {
    const example = await readFile(path.join(projectRoot, ".env.example"), "utf8");
    expect(example).toMatch(/^MIGRATE_DEV_DATABASE_URL=/m);
    expect(example).toContain("phb_platform_dev");
  });
});
