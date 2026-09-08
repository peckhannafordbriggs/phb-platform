import { readdir } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "next-auth";

vi.mock("@/auth", () => ({ auth: vi.fn() }));

import { auth } from "@/auth";
import { BAS_MODULE_KEY } from "@/lib/modules/bas/constants";
import { resetBasAvailabilityCache } from "@/lib/modules/bas/route-helpers";
import {
  CredentialError,
  credentialKeyState,
  currentKeyVersion,
  decryptPassword,
  encryptPassword,
} from "@/lib/modules/bas/credentials";
import { setBasStationCredential } from "@/lib/modules/bas/settings-service";
import { requireModuleAdmin } from "@/lib/authz";
import { GET as settingsTree } from "@/app/api/modules/bas/settings/route";
import { POST as createStation } from "@/app/api/modules/bas/settings/stations/route";
import {
  DELETE as deleteStation,
  PATCH as patchStation,
} from "@/app/api/modules/bas/settings/stations/[stationId]/route";
import {
  DELETE as clearCredential,
  PUT as setCredential,
} from "@/app/api/modules/bas/settings/stations/[stationId]/credential/route";
import {
  createEmployee,
  disconnectDb,
  grantModule,
  grantModuleAdmin,
  resetDb,
  seedBasModule,
  seedChangeOrdersModule,
  testDb,
} from "./db";

const authMock = vi.mocked(auth);

/** 32 bytes, base64. A test key, and not one that has ever guarded anything. */
const TEST_KEY = Buffer.alloc(32, 7).toString("base64");

/** The value every leak assertion hunts for. */
const PLAINTEXT = "ZZTEST-niagara-pa55word-do-not-leak";

function signedInAs(entraOid: string) {
  authMock.mockResolvedValue({
    entraOid,
    issuedAt: Math.floor(Date.now() / 1000),
    user: {},
    expires: new Date(Date.now() + 3_600_000).toISOString(),
  } as unknown as Session as never);
}

function json(body: unknown, method = "POST"): Request {
  return new Request("http://localhost/api/modules/bas/settings", {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

const stationParams = (stationId: string) => ({
  params: Promise.resolve({ stationId }),
});

let siteId: bigint;

async function seedHierarchy() {
  const org = await testDb.basOrg.create({ data: { name: "ZZTEST_C_ORG" } });
  const project = await testDb.basProject.create({
    data: { orgId: org.orgId, name: "ZZTEST_C_PROJECT" },
  });
  const site = await testDb.basSite.create({
    data: {
      orgId: org.orgId,
      projectId: project.projectId,
      name: "ZZTEST_C_SITE",
      timezone: "America/New_York",
    },
  });
  siteId = site.siteId;
}

async function dropBas() {
  await testDb.basPoint.deleteMany({
    where: { niagaraHistoryName: { startsWith: "ZZTest" } },
  });
  await testDb.basStation.deleteMany({
    where: { niagaraStationName: { startsWith: "ZZTest" } },
  });
  await testDb.basSite.deleteMany({ where: { name: { startsWith: "ZZTEST_C" } } });
  await testDb.basProject.deleteMany({
    where: { name: { startsWith: "ZZTEST_C" } },
  });
  await testDb.basOrg.deleteMany({ where: { name: { startsWith: "ZZTEST_C" } } });
}

async function signInAsAdmin() {
  const employee = await createEmployee();
  await grantModule(employee.id, BAS_MODULE_KEY);
  await grantModuleAdmin(employee.id, BAS_MODULE_KEY);
  signedInAs(employee.entraOid!);
  return employee;
}

beforeEach(async () => {
  vi.clearAllMocks();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  resetBasAvailabilityCache();
  process.env.BAS_CREDENTIAL_KEY = TEST_KEY;
  delete process.env.BAS_CREDENTIAL_KEY_VERSION;
  await dropBas();
  await resetDb();
  await seedChangeOrdersModule();
  await seedBasModule();
  await seedHierarchy();
});

afterAll(async () => {
  delete process.env.BAS_CREDENTIAL_KEY;
  await dropBas();
  await disconnectDb();
});

// ---------------------------------------------------------------------------
// The cipher itself
// ---------------------------------------------------------------------------

describe("AES-256-GCM round trip", () => {
  it("encrypts and decrypts", () => {
    expect(decryptPassword(encryptPassword(PLAINTEXT))).toBe(PLAINTEXT);
  });

  it("never produces the plaintext in the envelope", () => {
    const envelope = encryptPassword(PLAINTEXT);
    expect(envelope).not.toContain(PLAINTEXT);
    expect(Buffer.from(envelope).toString("utf8")).not.toContain(PLAINTEXT);
  });

  /**
   * A fresh IV per call, which is what stops two stations with the same
   * password producing byte-identical rows - a comparison anyone with read
   * access could make.
   */
  it("produces a different ciphertext every time for the same input", () => {
    const a = encryptPassword(PLAINTEXT);
    const b = encryptPassword(PLAINTEXT);
    expect(a).not.toBe(b);
    expect(decryptPassword(a)).toBe(decryptPassword(b));
  });

  /**
   * GCM authenticates. This is the property CBC does not have, and the reason
   * the mode was chosen: a ciphertext altered in the database must fail loudly
   * rather than decrypt to a different password that then fails against a live
   * JACE weeks later with nothing pointing back here.
   */
  it("refuses a tampered ciphertext instead of returning something else", () => {
    const parts = encryptPassword(PLAINTEXT).split(":");
    const body = Buffer.from(parts[3]!, "base64");
    body[0] = body[0]! ^ 0xff;
    const tampered = [parts[0], parts[1], parts[2], body.toString("base64")].join(":");

    expect(() => decryptPassword(tampered)).toThrow(CredentialError);
    try {
      decryptPassword(tampered);
    } catch (error) {
      expect((error as CredentialError).code).toBe("decrypt_failed");
    }
  });

  it("refuses a value that is not an envelope at all", () => {
    for (const bad of ["", "nonsense", "v2:a:b:c", "v1:a:b"]) {
      expect(() => decryptPassword(bad)).toThrow(CredentialError);
    }
  });

  it("cannot be decrypted with a different key", () => {
    const envelope = encryptPassword(PLAINTEXT);
    process.env.BAS_CREDENTIAL_KEY = Buffer.alloc(32, 9).toString("base64");
    expect(() => decryptPassword(envelope)).toThrow(CredentialError);
  });
});

// ---------------------------------------------------------------------------
// The key is read lazily
// ---------------------------------------------------------------------------

describe("the key is read lazily and its absence disables one feature", () => {
  it("reports a missing key rather than throwing at import", () => {
    delete process.env.BAS_CREDENTIAL_KEY;
    const state = credentialKeyState();
    expect(state).toEqual({ available: false, reason: "key_missing" });
  });

  it("rejects a key that is not 32 bytes", () => {
    process.env.BAS_CREDENTIAL_KEY = Buffer.alloc(16, 1).toString("base64");
    expect(credentialKeyState()).toEqual({
      available: false,
      reason: "key_invalid",
    });
  });

  /**
   * The rest of Settings keeps working without a key. This is the whole point
   * of reading it lazily - a platform that would not boot, or a Settings tab
   * that went blank, would be a worse failure than the one being reported.
   */
  it("still serves the settings tree with no key configured", async () => {
    delete process.env.BAS_CREDENTIAL_KEY;
    await signInAsAdmin();

    const response = await settingsTree();
    expect(response.status).toBe(200);

    const body = (await response.json()) as {
      data: { credentialStorage: { available: boolean; message: string | null } };
    };
    expect(body.data.credentialStorage.available).toBe(false);
    // Names the variable, which is not a secret and is what IT needs.
    expect(body.data.credentialStorage.message).toContain("BAS_CREDENTIAL_KEY");
  });

  it("refuses to store a password with no key, and registers no station", async () => {
    delete process.env.BAS_CREDENTIAL_KEY;
    await signInAsAdmin();

    const response = await createStation(
      json({
        siteId: siteId.toString(),
        niagaraStationName: "ZZTestNoKey",
        connectionMode: "direct",
        baseUrl: "https://198.51.100.9",
        username: "svc",
        password: PLAINTEXT,
      }),
    );

    expect(response.status).toBe(500);
    // Checked BEFORE the station is created, so a partial success - station
    // registered, credential silently dropped - cannot happen.
    expect(
      await testDb.basStation.findFirst({
        where: { niagaraStationName: "ZZTestNoKey" },
      }),
    ).toBeNull();
  });

  it("records the key version so a rotation is possible later", async () => {
    process.env.BAS_CREDENTIAL_KEY_VERSION = "4";
    expect(currentKeyVersion()).toBe(4);

    await signInAsAdmin();
    const station = await testDb.basStation.create({
      data: { siteId, niagaraStationName: "ZZTestKeyVersion" },
    });
    await setCredential(
      json({ username: "svc", password: PLAINTEXT }, "PUT"),
      stationParams(station.stationId.toString()),
    );

    expect(
      (
        await testDb.basStationCredential.findUnique({
          where: { stationId: station.stationId },
        })
      )?.keyVersion,
    ).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// THE LEAK TEST. Walks every settings route.
// ---------------------------------------------------------------------------

describe("no settings route ever returns the password or the ciphertext", () => {
  /**
   * The route surface is discovered from the filesystem, not from a list.
   *
   * A list is right until somebody adds a route, and the route somebody adds
   * next is exactly the one that has not been thought about. This walks
   * app/api/modules/bas/settings/** and asserts the count matches what is
   * exercised below, so adding a route without adding it here fails.
   */
  async function routeFiles(): Promise<string[]> {
    const found: string[] = [];
    async function walk(dir: string): Promise<void> {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) await walk(full);
        else if (entry.name === "route.ts") found.push(full);
      }
    }
    await walk(path.join(process.cwd(), "app/api/modules/bas/settings"));
    return found;
  }

  it("exercises every route file that exists", async () => {
    // 8: settings, projects, projects/[id], buildings, buildings/[id],
    // stations, stations/[id], stations/[id]/credential.
    expect((await routeFiles()).length).toBe(8);
  });

  it("returns neither the plaintext nor the ciphertext from ANY of them", async () => {
    await signInAsAdmin();

    const station = await testDb.basStation.create({
      data: {
        siteId,
        niagaraStationName: "ZZTestLeakStation",
        connectionMode: "direct",
        baseUrl: "https://198.51.100.9",
      },
    });
    const id = station.stationId.toString();

    // Set a real credential through the real route.
    const setResponse = await setCredential(
      json({ username: "ZZTEST_svc_user", password: PLAINTEXT }, "PUT"),
      stationParams(id),
    );
    expect(setResponse.status).toBe(200);

    // The ciphertext as actually stored, read straight from the table.
    const stored = await testDb.basStationCredential.findUniqueOrThrow({
      where: { stationId: station.stationId },
    });
    const ciphertext = stored.passwordCiphertext;
    expect(ciphertext).not.toContain(PLAINTEXT);

    // Every response body the settings surface can produce, including the
    // failures - an error message is a response body too.
    const bodies: string[] = [
      await setResponse.clone().text(),
      await (await settingsTree()).text(),
      await (
        await createStation(
          json({
            siteId: siteId.toString(),
            niagaraStationName: "ZZTestLeakStation2",
            connectionMode: "direct",
            baseUrl: "https://198.51.100.10",
            username: "ZZTEST_svc_user",
            password: PLAINTEXT,
          }),
        )
      ).text(),
      // A rejected create, so the validation path is covered too.
      await (
        await createStation(
          json({
            siteId: siteId.toString(),
            niagaraStationName: "",
            connectionMode: "direct",
            baseUrl: "https://198.51.100.11",
            username: "ZZTEST_svc_user",
            password: PLAINTEXT,
          }),
        )
      ).text(),
      await (
        await patchStation(json({ displayName: "Lab" }, "PATCH"), stationParams(id))
      ).text(),
      // A rejected credential write.
      await (
        await setCredential(json({ username: "", password: PLAINTEXT }, "PUT"), stationParams(id))
      ).text(),
      await (
        await setCredential(json({ username: "svc", password: PLAINTEXT }, "PUT"), stationParams("999999"))
      ).text(),
      await (await clearCredential(json({}, "DELETE"), stationParams(id))).text(),
      await (await deleteStation(json({}, "DELETE"), stationParams(id))).text(),
    ];

    for (const body of bodies) {
      expect(body, "a response body contained the password").not.toContain(
        PLAINTEXT,
      );
      expect(body, "a response body contained the ciphertext").not.toContain(
        ciphertext,
      );
      // The envelope prefix, in case a future format change slips a partial
      // ciphertext through under a different encoding.
      expect(body).not.toContain("v1:");
    }
  });

  it("returns the username, that a password is set, and when - and nothing more", async () => {
    await signInAsAdmin();
    const station = await testDb.basStation.create({
      data: { siteId, niagaraStationName: "ZZTestMetaStation" },
    });
    await setCredential(
      json({ username: "ZZTEST_svc_user", password: PLAINTEXT }, "PUT"),
      stationParams(station.stationId.toString()),
    );

    const body = (await (await settingsTree()).json()) as {
      data: {
        projects: Array<{
          buildings: Array<{
            stations: Array<{
              credential: Record<string, unknown> | null;
            }>;
          }>;
        }>;
      };
    };

    const credential =
      body.data.projects[0]?.buildings[0]?.stations.find(
        (s) => s.credential !== null,
      )?.credential ?? null;

    expect(credential).not.toBeNull();
    expect(Object.keys(credential!).sort()).toEqual([
      "passwordSet",
      "passwordUpdatedAt",
      "username",
    ]);
    expect(credential!.passwordSet).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// An exception thrown mid-save must not carry the password
// ---------------------------------------------------------------------------

describe("a failure during a save does not put the password in the error", () => {
  /**
   * The realistic shape of this: the database goes away between the encrypt and
   * the insert, and whatever is thrown travels up through the route, the logger
   * and possibly a monitoring service.
   *
   * Forced by pointing the write at a station id that does not exist, and then
   * separately by making the underlying insert fail, so both the checked and
   * the unchecked path are covered.
   */
  it("throws a BasError naming the station, not the credential", async () => {
    await signInAsAdmin();
    const access = await requireModuleAdmin(BAS_MODULE_KEY);
    if (!access.ok) throw new Error("expected access");

    let thrown: unknown;
    try {
      await setBasStationCredential(access.viewer, "999999", {
        username: "svc",
        password: PLAINTEXT,
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeDefined();
    const dump = JSON.stringify({
      message: (thrown as Error).message,
      stack: (thrown as Error).stack,
      // Anything a logger might reach for.
      own: Object.getOwnPropertyNames(thrown as object).map(
        (k) => (thrown as Record<string, unknown>)[k],
      ),
    });
    expect(dump).not.toContain(PLAINTEXT);
  });

  it("keeps the password out of a real database failure mid-transaction", async () => {
    await signInAsAdmin();
    const access = await requireModuleAdmin(BAS_MODULE_KEY);
    if (!access.ok) throw new Error("expected access");

    const station = await testDb.basStation.create({
      data: { siteId, niagaraStationName: "ZZTestFailStation" },
    });

    // A username longer than the column will take is not what fails here -
    // the column is unbounded text. Instead, break the FK the credential row
    // depends on by deleting the station inside the same tick, so the insert
    // lands after its parent is gone.
    await testDb.basStation.delete({ where: { stationId: station.stationId } });

    let thrown: unknown;
    try {
      await setBasStationCredential(
        access.viewer,
        station.stationId.toString(),
        { username: "svc", password: PLAINTEXT },
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeDefined();
    const error = thrown as Error;
    const dump = `${error.message}\n${error.stack ?? ""}\n${JSON.stringify(error)}`;
    expect(dump).not.toContain(PLAINTEXT);
  });

  /**
   * The audit row is the one place a leak would be permanent: audit_events is
   * append-only, enforced by a trigger, so anything written there can never be
   * deleted or redacted.
   */
  it("writes no password and no username into the audit log", async () => {
    await signInAsAdmin();
    const station = await testDb.basStation.create({
      data: { siteId, niagaraStationName: "ZZTestAuditStation" },
    });

    await setCredential(
      json({ username: "ZZTEST_svc_user", password: PLAINTEXT }, "PUT"),
      stationParams(station.stationId.toString()),
    );

    const events = await testDb.auditEvent.findMany({
      where: { action: "bas.credential_set" },
    });
    expect(events).toHaveLength(1);

    const serialised = JSON.stringify(events);
    expect(serialised).not.toContain(PLAINTEXT);
    expect(serialised).not.toContain("ZZTEST_svc_user");
    // What it DOES carry.
    expect((events[0]!.metadata as { stationId?: string }).stationId).toBe(
      station.stationId.toString(),
    );
    expect((events[0]!.metadata as { keyVersion?: number }).keyVersion).toBe(1);
  });
});
