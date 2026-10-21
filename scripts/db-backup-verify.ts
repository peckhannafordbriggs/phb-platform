/**
 * Drives the REAL nightly-backup image end to end, locally, with nothing in
 * Azure: `npm run db:backup:verify`.
 *
 * What runs is exactly what production runs - the image built from
 * infra/db-backup/Dockerfile, the script inside it, pg_dump 17 against a
 * PostgreSQL 17 - with two stand-ins for the parts that are Azure's:
 *
 *   - a throwaway `postgres:17-alpine` container, migrated with the real
 *     Prisma migrations, so the dump is of the platform's own schema;
 *   - a fake of the Container Apps identity endpoint and the blob endpoint,
 *     one small HTTP server on this machine, which checks what the script
 *     sends the way the real services would: the identity header and client
 *     id on the token request, the bearer token and the Content-MD5 on the
 *     upload (the service refuses a mismatch with 400, so does this).
 *
 * Then the properties the job is built for are asserted, not assumed:
 *
 *   1. the run exits 0, one blob lands, its bytes are what pg_dump wrote
 *      (MD5 matched by the "service"), and pg_restore on THIS machine reads
 *      the stored bytes and finds the platform's tables in them;
 *   2. the password is nowhere: not in the container's output, not in any
 *      URL or header the fake server saw - with a password built of the
 *      characters that break naive URL handling (@ % : / ? #);
 *   3. three failures each exit non-zero and leave no blob: a refused token,
 *      a wrong database password, no DATABASE_URL at all. The execution
 *      would show Failed rather than lying.
 *
 * Needs docker, and pg_restore on the PATH for the read-back. Writes nothing
 * outside docker and the scratch directory. Never touches a real database.
 */

import { createHash } from "node:crypto";
import { spawn, spawnSync, type SpawnSyncReturns } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { AddressInfo } from "node:net";

const ROOT = process.cwd();
const IMAGE = "phb-db-backup:verify";
const NETWORK = "phb-db-backup-verify-net";
const PG_CONTAINER = "phb-db-backup-verify-pg";
const DATABASE = "phb_platform";
// Every character that a naive URL split or decode gets wrong.
const PASSWORD = "p@ss%word:x/y?z#1";
const PASSWORD_ENCODED = encodeURIComponent(PASSWORD);
const CLIENT_ID = "11111111-2222-3333-4444-555555555555";
const IDENTITY_HEADER = "identity-header-value-never-printed";
const TOKEN = "bearer-token-value-never-printed";
const CONTAINER = "dumps";

interface Seen {
  method: string;
  url: string;
  headers: Record<string, string>;
  status: number;
}

function run(cmd: string, args: string[], opts: { env?: Record<string, string>; input?: string } = {}): SpawnSyncReturns<string> {
  return spawnSync(cmd, args, {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, ...opts.env },
    input: opts.input,
    maxBuffer: 64 * 1024 * 1024,
  });
}

function must(result: SpawnSyncReturns<string>, what: string): string {
  if (result.status !== 0) {
    throw new Error(`${what} failed (${result.status}):\n${result.stdout}\n${result.stderr}`);
  }
  return result.stdout;
}

const failures: string[] = [];
function check(ok: boolean, what: string): void {
  console.log(`${ok ? "  ok  " : "  FAIL"} ${what}`);
  if (!ok) failures.push(what);
}

function md5Base64(bytes: Buffer): string {
  return createHash("md5").update(bytes).digest("base64");
}

/** The two Azure endpoints the script talks to, as one server. */
function fakeAzure(store: Map<string, Buffer>, seen: Seen[], behaviour: { refuseToken: boolean }) {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      const url = new URL(req.url ?? "/", "http://fake");
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers)) headers[k] = Array.isArray(v) ? v.join(",") : (v ?? "");
      const answer = (status: number, payload: string | Buffer = "", extra: Record<string, string> = {}) => {
        seen.push({ method: req.method ?? "", url: req.url ?? "", headers, status });
        res.writeHead(status, extra);
        res.end(payload);
      };

      if (req.method === "GET" && url.pathname === "/token") {
        const ok =
          !behaviour.refuseToken &&
          headers["x-identity-header"] === IDENTITY_HEADER &&
          url.searchParams.get("client_id") === CLIENT_ID &&
          url.searchParams.get("resource") === "https://storage.azure.com/" &&
          url.searchParams.get("api-version") === "2019-08-01";
        if (!ok) return answer(401, JSON.stringify({ error: "unauthorized" }));
        return answer(200, JSON.stringify({ access_token: TOKEN, expires_on: "9999999999", token_type: "Bearer" }), {
          "content-type": "application/json",
        });
      }

      const blob = url.pathname.match(new RegExp(`^/${CONTAINER}/([^/]+)$`));
      if (blob) {
        if (headers.authorization !== `Bearer ${TOKEN}`) return answer(403, "<Error><Code>AuthorizationFailure</Code></Error>");
        const name = decodeURIComponent(blob[1]!);
        if (req.method === "PUT") {
          if (headers["x-ms-blob-type"] !== "BlockBlob") return answer(400, "<Error><Code>MissingRequiredHeader</Code></Error>");
          if (headers["content-md5"] !== md5Base64(body)) return answer(400, "<Error><Code>Md5Mismatch</Code></Error>");
          if (String(body.length) !== headers["content-length"]) return answer(400, "<Error><Code>InvalidHeaderValue</Code></Error>");
          store.set(name, body);
          return answer(201, "", { "content-md5": headers["content-md5"]!, etag: '"1"' });
        }
        if (req.method === "HEAD") {
          const stored = store.get(name);
          if (!stored) return answer(404);
          return answer(200, "", { "content-length": String(stored.length), "content-md5": md5Base64(stored) });
        }
      }
      return answer(404, "<Error><Code>ResourceNotFound</Code></Error>");
    });
  });
}

function containsSecret(text: string): string[] {
  const found: string[] = [];
  for (const [label, value] of [
    ["the password", PASSWORD],
    ["the encoded password", PASSWORD_ENCODED],
    ["the bearer token", TOKEN],
    ["the identity header", IDENTITY_HEADER],
  ] as const) {
    if (text.includes(value)) found.push(label);
  }
  return found;
}

interface Outcome {
  status: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Asynchronous, unlike every other docker call here: the fake Azure is an
 * HTTP server in THIS process, and a spawnSync would block the event loop
 * for as long as the container waited for an answer - which is forever.
 */
function runBackup(env: Record<string, string>): Promise<Outcome> {
  const args = ["run", "--rm", "--network", NETWORK, "--add-host=host.docker.internal:host-gateway"];
  for (const [k, v] of Object.entries(env)) args.push("-e", `${k}=${v}`);
  args.push(IMAGE);
  return new Promise((resolve, reject) => {
    const child = spawn("docker", args, { cwd: ROOT });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (d: string) => (stdout += d));
    child.stderr.setEncoding("utf8").on("data", (d: string) => (stderr += d));
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

async function main(): Promise<void> {
  must(run("docker", ["info", "--format", "{{.ServerVersion}}"]), "docker info (is Docker running?)");
  must(run("pg_restore", ["--version"]), "pg_restore --version (needed on this machine for the read-back)");

  const scratch = mkdtempSync(path.join(tmpdir(), "phb-db-backup-verify-"));
  const store = new Map<string, Buffer>();
  const seen: Seen[] = [];
  const behaviour = { refuseToken: false };
  const server = fakeAzure(store, seen, behaviour);
  // All interfaces: the container reaches this machine as host.docker.internal,
  // which is not loopback from inside the Docker VM.
  await new Promise<void>((resolve) => server.listen(0, "0.0.0.0", resolve));
  const port = (server.address() as AddressInfo).port;
  const endpoint = `http://host.docker.internal:${port}`;

  // Everything attached to the network goes first - a backup container from
  // an interrupted earlier run keeps the network alive otherwise.
  const removeDockerState = () => {
    const attached = run("docker", ["ps", "-aq", "--filter", `network=${NETWORK}`]).stdout.trim().split(/\s+/).filter(Boolean);
    for (const id of attached) run("docker", ["rm", "-f", id]);
    run("docker", ["rm", "-f", PG_CONTAINER]);
    run("docker", ["network", "rm", NETWORK]);
  };
  const cleanup = () => {
    removeDockerState();
    server.close();
    rmSync(scratch, { recursive: true, force: true });
  };

  try {
    console.log("Building the image from infra/db-backup ...");
    must(run("docker", ["build", "-q", "-t", IMAGE, "infra/db-backup"]), "docker build");

    console.log("Starting a throwaway PostgreSQL 17 ...");
    removeDockerState();
    must(run("docker", ["network", "create", NETWORK]), "docker network create");
    must(
      run("docker", [
        "run", "-d", "--name", PG_CONTAINER, "--network", NETWORK,
        "-e", `POSTGRES_PASSWORD=${PASSWORD}`, "-e", `POSTGRES_DB=${DATABASE}`,
        "-p", "127.0.0.1:0:5432", "postgres:17-alpine",
      ]),
      "docker run postgres",
    );
    const hostPort = must(run("docker", ["port", PG_CONTAINER, "5432/tcp"]), "docker port").trim().split(":").pop();
    for (let i = 0; ; i++) {
      const ready = run("docker", ["exec", PG_CONTAINER, "pg_isready", "-U", "postgres", "-d", DATABASE]);
      if (ready.status === 0) break;
      if (i > 60) throw new Error("postgres did not become ready");
      await new Promise((r) => setTimeout(r, 1000));
    }
    // The server's own first start can accept a connection and then restart
    // once initdb finishes; a second ready is the real one.
    await new Promise((r) => setTimeout(r, 2000));

    console.log("Applying the platform's migrations to it ...");
    const hostUrl = `postgresql://postgres:${PASSWORD_ENCODED}@127.0.0.1:${hostPort}/${DATABASE}?sslmode=disable`;
    must(
      run(process.execPath, ["node_modules/prisma/build/index.js", "migrate", "deploy"], {
        env: { DATABASE_URL: hostUrl },
      }),
      "prisma migrate deploy",
    );

    const containerUrl = `postgresql://postgres:${PASSWORD_ENCODED}@${PG_CONTAINER}:5432/${DATABASE}?sslmode=disable`;
    const baseEnv = {
      DATABASE_URL: containerUrl,
      BACKUP_BLOB_ENDPOINT: `${endpoint}/`,
      BACKUP_CONTAINER: CONTAINER,
      AZURE_CLIENT_ID: CLIENT_ID,
      IDENTITY_ENDPOINT: `${endpoint}/token`,
      IDENTITY_HEADER,
    };

    console.log("\n1. The happy path");
    const good = await runBackup(baseEnv);
    const output = good.stdout + good.stderr;
    console.log(output.split("\n").map((l) => `     | ${l}`).join("\n"));
    check(good.status === 0, "exits 0");
    check(store.size === 1, `exactly one blob landed (${store.size})`);
    const [name, bytes] = [...store.entries()][0] ?? ["", Buffer.alloc(0)];
    check(/^phb_platform_\d{4}-\d{2}-\d{2}_\d{4}Z\.dump$/.test(name), `the name carries the UTC date and says so: ${name}`);
    check(bytes.length > 0, `the blob is not empty (${bytes.length} bytes)`);
    check(output.includes(`OK: ${CONTAINER}/${name}, ${bytes.length} bytes`), "the OK line names the blob and the byte count the server stored");
    const putReq = seen.find((s) => s.method === "PUT");
    const headReq = seen.find((s) => s.method === "HEAD");
    check(putReq?.status === 201 && putReq.headers["content-md5"] === md5Base64(bytes), "the upload carried the Content-MD5 the service verified");
    check(headReq?.status === 200, "the blob was confirmed with a HEAD after the upload");
    const dumpPath = path.join(scratch, name);
    writeFileSync(dumpPath, bytes);
    const toc = run("pg_restore", ["--list", dumpPath]);
    check(toc.status === 0, "pg_restore on this machine reads the stored bytes");
    check(/TABLE DATA public _prisma_migrations/.test(toc.stdout), "the archive holds _prisma_migrations");
    check(/TABLE DATA public bas_readings/.test(toc.stdout), "the archive holds bas_readings");
    check(/TABLE DATA public employees/.test(toc.stdout), "the archive holds employees");
    const tables = (toc.stdout.match(/ TABLE DATA /g) ?? []).length;
    check(output.includes(`${tables} tables`), `the log's table count matches pg_restore's (${tables})`);

    console.log("\n2. The password is nowhere");
    check(containsSecret(output).length === 0, `the container's output holds no secret (${containsSecret(output).join(", ") || "none"})`);
    const leaked = seen.flatMap((s) => containsSecret(s.url + JSON.stringify(s.headers)).map((l) => `${l} in ${s.method} ${s.url.split("?")[0]}`));
    const tokenInHeaderOnly = seen
      .filter((s) => s.method !== "GET")
      .every((s) => s.headers.authorization === `Bearer ${TOKEN}` && !s.url.includes(TOKEN));
    check(!leaked.some((l) => l.startsWith("the password") || l.startsWith("the encoded password")), `no request to the fake Azure carried the password (${leaked.filter((l) => l.includes("password")).join("; ") || "none"})`);
    check(tokenInHeaderOnly, "the token travels in the Authorization header and never in a URL");
    check(output.includes(`as postgres, sslmode=disable`), "sslmode came from the URL's query string");

    console.log("\n3. Three failures, each Failed rather than quiet");
    store.clear();
    behaviour.refuseToken = true;
    const refused = await runBackup(baseEnv);
    behaviour.refuseToken = false;
    check(refused.status !== 0, `a refused token exits non-zero (${refused.status})`);
    check(store.size === 0, "and uploads nothing");
    check(/FAILED: the identity endpoint/.test(refused.stdout + refused.stderr), "and says which step failed");
    check(containsSecret(refused.stdout + refused.stderr).length === 0, "and prints no secret");

    const wrongPassword = await runBackup({ ...baseEnv, DATABASE_URL: containerUrl.replace(PASSWORD_ENCODED, "wrong") });
    check(wrongPassword.status !== 0, `a wrong database password exits non-zero (${wrongPassword.status})`);
    check(store.size === 0, "and uploads nothing");
    check(/FAILED: pg_dump exited non-zero/.test(wrongPassword.stdout + wrongPassword.stderr), "and names pg_dump");

    const { DATABASE_URL: _dropped, ...withoutUrl } = baseEnv;
    void _dropped;
    const unset = await runBackup(withoutUrl);
    check(unset.status !== 0, `no DATABASE_URL exits non-zero (${unset.status})`);
    check(/FAILED: DATABASE_URL is not set/.test(unset.stdout + unset.stderr), "and says so");
    check(store.size === 0, "and uploads nothing");
  } finally {
    cleanup();
  }

  console.log("");
  if (failures.length > 0) {
    console.log(`${failures.length} check(s) failed:\n  - ${failures.join("\n  - ")}`);
    process.exit(1);
  }
  console.log("All checks passed: the image dumps, verifies, uploads with MD5, confirms, and fails loudly.");
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
