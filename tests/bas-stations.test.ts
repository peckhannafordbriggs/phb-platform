import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "next-auth";

vi.mock("@/auth", () => ({ auth: vi.fn() }));

import { auth } from "@/auth";
import { BAS_MODULE_KEY } from "@/lib/modules/bas/constants";
import { resetBasAvailabilityCache } from "@/lib/modules/bas/route-helpers";
import { getBasSettingsTree } from "@/lib/modules/bas/settings-service";
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
const TEST_KEY = Buffer.alloc(32, 7).toString("base64");

/** The live lab station's fingerprint, as measured. Used for shape tests only. */
const REAL_FINGERPRINT =
  "483bc6d6cbefa12914398e7e27010b6275b287503ac19e0c783482278dc186b4";

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

/**
 * The settings tree route takes a Request as of B7.6, so it can read the search
 * and filter parameters out of the query string. Unfiltered unless a test
 * passes one.
 */
function treeRequest(query = ""): Request {
  return new Request("http://localhost/api/modules/bas/settings" + query);
}

const stationParams = (stationId: string) => ({
  params: Promise.resolve({ stationId }),
});

async function body(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

let siteId: bigint;
let otherSiteId: bigint;

async function seedHierarchy() {
  const org = await testDb.basOrg.create({ data: { name: "ZZTEST_S_ORG" } });
  const project = await testDb.basProject.create({
    data: { orgId: org.orgId, name: "ZZTEST_S_PROJECT" },
  });
  const site = await testDb.basSite.create({
    data: {
      orgId: org.orgId,
      projectId: project.projectId,
      name: "ZZTEST_S_SITE",
      timezone: "America/New_York",
    },
  });
  const other = await testDb.basSite.create({
    data: {
      orgId: org.orgId,
      projectId: project.projectId,
      name: "ZZTEST_S_SITE_B",
      timezone: "America/New_York",
    },
  });
  siteId = site.siteId;
  otherSiteId = other.siteId;
}

async function dropBas() {
  // Children before parents, and there are three generations here.
  // bas_ingest_runs.station_id is RESTRICT - deleting the station first fails
  // and leaves the whole chain behind, which the next file then reports as a
  // count it cannot explain. Checkpoints and gaps cascade from the point.
  await testDb.basIngestRun.deleteMany({
    where: { station: { niagaraStationName: { contains: "ZZTest" } } },
  });
  await testDb.basPoint.deleteMany({
    where: { niagaraHistoryName: { startsWith: "ZZTest" } },
  });
  await testDb.basStation.deleteMany({
    where: { niagaraStationName: { contains: "ZZTest" } },
  });
  await testDb.basSite.deleteMany({ where: { name: { startsWith: "ZZTEST_S" } } });
  await testDb.basProject.deleteMany({
    where: { name: { startsWith: "ZZTEST_S" } },
  });
  await testDb.basOrg.deleteMany({ where: { name: { startsWith: "ZZTEST_S" } } });
}

async function signInAsAdmin() {
  const employee = await createEmployee();
  await grantModule(employee.id, BAS_MODULE_KEY);
  await grantModuleAdmin(employee.id, BAS_MODULE_KEY);
  signedInAs(employee.entraOid!);
  return employee;
}

async function signInAsPlainBasUser() {
  const employee = await createEmployee();
  await grantModule(employee.id, BAS_MODULE_KEY);
  signedInAs(employee.entraOid!);
  return employee;
}

async function adminViewer() {
  await signInAsAdmin();
  const access = await requireModuleAdmin(BAS_MODULE_KEY);
  if (!access.ok) throw new Error(`expected access, got ${access.denial}`);
  return access.viewer;
}

beforeEach(async () => {
  vi.clearAllMocks();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  resetBasAvailabilityCache();
  process.env.BAS_CREDENTIAL_KEY = TEST_KEY;
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
// Negative tests
// ---------------------------------------------------------------------------

describe("a BAS user without the admin flag cannot touch stations", () => {
  it("gets 404 from all four station routes", async () => {
    const station = await testDb.basStation.create({
      data: { siteId, niagaraStationName: "ZZTestGuarded" },
    });
    const id = station.stationId.toString();
    await signInAsPlainBasUser();

    expect(
      (
        await createStation(
          json({
            siteId: siteId.toString(),
            niagaraStationName: "ZZTestSneaky",
            connectionMode: "direct",
            baseUrl: "https://198.51.100.1",
          }),
        )
      ).status,
    ).toBe(404);
    expect(
      (await patchStation(json({ displayName: "x" }, "PATCH"), stationParams(id)))
        .status,
    ).toBe(404);
    expect(
      (await deleteStation(json({}, "DELETE"), stationParams(id))).status,
    ).toBe(404);
    expect(
      (
        await setCredential(
          json({ username: "svc", password: "hunter2" }, "PUT"),
          stationParams(id),
        )
      ).status,
    ).toBe(404);
    expect(
      (await clearCredential(json({}, "DELETE"), stationParams(id))).status,
    ).toBe(404);
  });

  /**
   * The refusal has to actually refuse. A status code says nothing about what
   * happened before it was returned.
   */
  it("writes nothing while being refused", async () => {
    const station = await testDb.basStation.create({
      data: {
        siteId,
        niagaraStationName: "ZZTestUntouched",
        displayName: "original",
      },
    });
    const id = station.stationId.toString();
    const before = await testDb.basStation.count();
    await signInAsPlainBasUser();

    await createStation(
      json({
        siteId: siteId.toString(),
        niagaraStationName: "ZZTestSneaky",
        connectionMode: "direct",
        baseUrl: "https://198.51.100.1",
      }),
    );
    await patchStation(json({ displayName: "hacked" }, "PATCH"), stationParams(id));
    await deleteStation(json({}, "DELETE"), stationParams(id));
    await setCredential(
      json({ username: "svc", password: "hunter2" }, "PUT"),
      stationParams(id),
    );

    expect(await testDb.basStation.count()).toBe(before);
    const after = await testDb.basStation.findUniqueOrThrow({
      where: { stationId: station.stationId },
    });
    expect(after.displayName).toBe("original");
    expect(await testDb.basStationCredential.count()).toBe(0);
    expect(
      await testDb.auditEvent.count({
        where: { action: { startsWith: "bas.station" } },
      }),
    ).toBe(0);
    expect(
      await testDb.auditEvent.count({
        where: { action: { startsWith: "bas.credential" } },
      }),
    ).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// The Niagara name and the base URL are stored EXACTLY as typed
// ---------------------------------------------------------------------------

describe("identifiers are stored verbatim", () => {
  /**
   * `SpringGroveLabComputer` is the live value and it appears literally in
   * every oBIX URL. Lowercasing or title-casing it 404s every request the
   * collector makes, silently, for as long as nobody checks.
   */
  it("preserves the case of the Niagara station name", async () => {
    await signInAsAdmin();

    await createStation(
      json({
        siteId: siteId.toString(),
        niagaraStationName: "ZZTestSpringGroveLabComputer",
        connectionMode: "direct",
        baseUrl: "https://196.1.1.213",
      }),
    );

    const station = await testDb.basStation.findFirstOrThrow({
      where: { siteId },
    });
    expect(station.niagaraStationName).toBe("ZZTestSpringGroveLabComputer");
    // Not lowercased, not title-cased, not otherwise touched.
    expect(station.niagaraStationName).not.toBe(
      "zztestspringgrovelabcomputer",
    );
  });

  /**
   * Not trimmed either. A space a person typed is either part of what Niagara
   * answers to or it is not, and the validation layer does not get to decide -
   * a silently rewritten identifier is much harder to debug than one that
   * simply returns nothing.
   */
  it("does not trim the Niagara station name", async () => {
    await signInAsAdmin();

    const response = await createStation(
      json({
        siteId: siteId.toString(),
        niagaraStationName: " ZZTestPadded ",
        connectionMode: "direct",
        baseUrl: "https://198.51.100.2",
      }),
    );
    expect(response.status).toBe(201);

    const station = await testDb.basStation.findFirstOrThrow({
      where: { siteId },
    });
    expect(station.niagaraStationName).toBe(" ZZTestPadded ");
  });

  it("still refuses a name that is only whitespace", async () => {
    await signInAsAdmin();
    expect(
      (
        await createStation(
          json({
            siteId: siteId.toString(),
            niagaraStationName: "   ",
            connectionMode: "direct",
            baseUrl: "https://198.51.100.3",
          }),
        )
      ).status,
    ).toBe(422);
  });

  /**
   * The live value is `https://196.1.1.213` with no trailing slash. Adding one
   * produces `//obix` in every URL the collector builds.
   */
  it("does not add a trailing slash to the base URL", async () => {
    await signInAsAdmin();

    await createStation(
      json({
        siteId: siteId.toString(),
        niagaraStationName: "ZZTestUrl",
        connectionMode: "direct",
        baseUrl: "https://196.1.1.213",
      }),
    );

    const station = await testDb.basStation.findFirstOrThrow({ where: { siteId } });
    expect(station.baseUrl).toBe("https://196.1.1.213");
    expect(station.baseUrl?.endsWith("/")).toBe(false);
  });

  it("does not remove one either, if a person typed it", async () => {
    await signInAsAdmin();
    await createStation(
      json({
        siteId: siteId.toString(),
        niagaraStationName: "ZZTestUrlSlash",
        connectionMode: "direct",
        baseUrl: "https://196.1.1.213/",
      }),
    );
    const station = await testDb.basStation.findFirstOrThrow({ where: { siteId } });
    expect(station.baseUrl).toBe("https://196.1.1.213/");
  });
});

// ---------------------------------------------------------------------------
// The TLS fingerprint, which IS normalised
// ---------------------------------------------------------------------------

describe("the TLS fingerprint is normalised, unlike the identifiers", () => {
  async function create(fingerprint: string) {
    return createStation(
      json({
        siteId: siteId.toString(),
        niagaraStationName: `ZZTestTls${Math.random().toString(36).slice(2, 8)}`,
        connectionMode: "direct",
        baseUrl: "https://198.51.100.4",
        tlsSha256: fingerprint,
      }),
    );
  }

  /**
   * Workbench and openssl each print a fingerprint their own way. Someone
   * pasting from either should not have to know which - a fingerprint is a
   * number written in hex, so case and colons carry no information.
   */
  it("strips colons and lowercases", async () => {
    await signInAsAdmin();
    const withColons = REAL_FINGERPRINT.toUpperCase()
      .match(/.{2}/g)!
      .join(":");

    expect((await create(withColons)).status).toBe(201);
    const station = await testDb.basStation.findFirstOrThrow({ where: { siteId } });
    expect(station.tlsSha256).toBe(REAL_FINGERPRINT);
  });

  it("refuses anything that is not 64 hex characters", async () => {
    await signInAsAdmin();
    for (const bad of ["abc", REAL_FINGERPRINT + "aa", "z".repeat(64)]) {
      expect((await create(bad)).status).toBe(422);
    }
  });

  it("accepts no fingerprint at all", async () => {
    await signInAsAdmin();
    expect(
      (
        await createStation(
          json({
            siteId: siteId.toString(),
            niagaraStationName: "ZZTestNoTls",
            connectionMode: "direct",
            baseUrl: "https://198.51.100.5",
          }),
        )
      ).status,
    ).toBe(201);
    const station = await testDb.basStation.findFirstOrThrow({ where: { siteId } });
    expect(station.tlsSha256).toBeNull();
  });

  /**
   * The database backs the normalisation up. The service lowercases on write;
   * this is what makes that true rather than merely usual.
   */
  it("is refused by the database if something writes an unnormalised value", async () => {
    const station = await testDb.basStation.create({
      data: { siteId, niagaraStationName: "ZZTestRawTls" },
    });

    await expect(
      testDb.$executeRawUnsafe(
        `UPDATE bas_stations SET tls_sha256 = $1 WHERE station_id = $2`,
        REAL_FINGERPRINT.toUpperCase(),
        station.stationId,
      ),
    ).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Connection mode: the form is strict, the database deliberately is not
// ---------------------------------------------------------------------------

describe("connection mode validation lives in the form, not the database", () => {
  it("refuses a direct station with no address", async () => {
    await signInAsAdmin();
    const response = await createStation(
      json({
        siteId: siteId.toString(),
        niagaraStationName: "ZZTestNoUrl",
        connectionMode: "direct",
      }),
    );
    expect(response.status).toBe(422);
    expect(String((await body(response)).error)).toContain("");
  });

  it("refuses a via_parent station with no parent", async () => {
    await signInAsAdmin();
    expect(
      (
        await createStation(
          json({
            siteId: siteId.toString(),
            niagaraStationName: "ZZTestNoParent",
            connectionMode: "via_parent",
          }),
        )
      ).status,
    ).toBe(422);
  });

  /**
   * THE ROW IS STILL STORABLE. B7.1 deliberately did not add a CHECK for this,
   * because `via_parent` with no parent is exactly what a JACE linked in
   * Workbench and never labelled here looks like - and B7.2 renders it amber as
   * "discovered, unassigned". A constraint would make the state unrepresentable
   * instead of visible, which is the opposite of what this module needs.
   */
  it("but the database still stores via_parent with no parent, and it renders amber", async () => {
    const station = await testDb.basStation.create({
      data: {
        siteId,
        niagaraStationName: "ZZTestDiscovered",
        connectionMode: "via_parent",
      },
    });
    expect(station.parentStationId).toBeNull();

    const tree = await getBasSettingsTree(await adminViewer());
    const row = tree.projects
      .flatMap((p) => p.buildings)
      .flatMap((b) => b.stations)
      .find((s) => s.niagaraStationName === "ZZTestDiscovered");

    expect(row?.reach).toBe("unconfigured");
  });
});

// ---------------------------------------------------------------------------
// Parent cycles
// ---------------------------------------------------------------------------

describe("a station cannot import its own history, directly or in a loop", () => {
  it("refuses a station as its own parent", async () => {
    await signInAsAdmin();
    const station = await testDb.basStation.create({
      data: { siteId, niagaraStationName: "ZZTestSelf" },
    });

    const response = await patchStation(
      json(
        {
          connectionMode: "via_parent",
          parentStationId: station.stationId.toString(),
        },
        "PATCH",
      ),
      stationParams(station.stationId.toString()),
    );

    expect(response.status).toBe(409);
    expect((await body(response)).error).toMatchObject({
      code: "station_cycle",
    });
    expect(
      (await testDb.basStation.findUniqueOrThrow({
        where: { stationId: station.stationId },
      })).parentStationId,
    ).toBeNull();
  });

  /**
   * A -> B already, then B -> A. The foreign key permits this happily: it
   * checks that the parent exists and nothing else. Only this walk catches it,
   * and without it any later "follow the chain to the collecting station" loops
   * forever.
   */
  it("refuses a two-station loop", async () => {
    await signInAsAdmin();
    const a = await testDb.basStation.create({
      data: { siteId, niagaraStationName: "ZZTestCycleA" },
    });
    const b = await testDb.basStation.create({
      data: {
        siteId,
        niagaraStationName: "ZZTestCycleB",
        connectionMode: "via_parent",
        parentStationId: a.stationId,
      },
    });

    const response = await patchStation(
      json(
        { connectionMode: "via_parent", parentStationId: b.stationId.toString() },
        "PATCH",
      ),
      stationParams(a.stationId.toString()),
    );

    expect(response.status).toBe(409);
    expect((await body(response)).error).toMatchObject({ code: "station_cycle" });
  });

  it("refuses a three-station loop", async () => {
    await signInAsAdmin();
    const a = await testDb.basStation.create({
      data: { siteId, niagaraStationName: "ZZTestChainA" },
    });
    const b = await testDb.basStation.create({
      data: {
        siteId,
        niagaraStationName: "ZZTestChainB",
        connectionMode: "via_parent",
        parentStationId: a.stationId,
      },
    });
    const c = await testDb.basStation.create({
      data: {
        siteId,
        niagaraStationName: "ZZTestChainC",
        connectionMode: "via_parent",
        parentStationId: b.stationId,
      },
    });

    expect(
      (
        await patchStation(
          json(
            {
              connectionMode: "via_parent",
              parentStationId: c.stationId.toString(),
            },
            "PATCH",
          ),
          stationParams(a.stationId.toString()),
        )
      ).status,
    ).toBe(409);
  });

  it("allows a legitimate chain", async () => {
    await signInAsAdmin();
    const central = await testDb.basStation.create({
      data: { siteId, niagaraStationName: "ZZTestCentral" },
    });

    const response = await createStation(
      json({
        siteId: otherSiteId.toString(),
        niagaraStationName: "ZZTestLeaf",
        connectionMode: "via_parent",
        parentStationId: central.stationId.toString(),
      }),
    );

    expect(response.status).toBe(201);
    const leaf = await testDb.basStation.findFirstOrThrow({
      where: { niagaraStationName: "ZZTestLeaf" },
    });
    expect(leaf.parentStationId).toBe(central.stationId);
  });

  it("404s on a parent that does not exist", async () => {
    await signInAsAdmin();
    expect(
      (
        await createStation(
          json({
            siteId: siteId.toString(),
            niagaraStationName: "ZZTestOrphan",
            connectionMode: "via_parent",
            parentStationId: "999999",
          }),
        )
      ).status,
    ).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Uniqueness the collector depends on
// ---------------------------------------------------------------------------

describe("(site_id, niagara_station_name) stays unique", () => {
  /**
   * The collector's `ensure_station` in phb-bas upserts with
   * `ON CONFLICT (site_id, niagara_station_name)`. Changing this key would
   * break that at plan time, which is exactly what happened to `ensure_site`
   * when B7.1 moved the building key.
   */
  it("refuses a duplicate name in the same building", async () => {
    await signInAsAdmin();
    await createStation(
      json({
        siteId: siteId.toString(),
        niagaraStationName: "ZZTestDup",
        connectionMode: "direct",
        baseUrl: "https://198.51.100.6",
      }),
    );

    const again = await createStation(
      json({
        siteId: siteId.toString(),
        niagaraStationName: "ZZTestDup",
        connectionMode: "direct",
        baseUrl: "https://198.51.100.7",
      }),
    );

    expect(again.status).toBe(409);
    expect((await body(again)).error).toMatchObject({ code: "name_taken" });
  });

  it("allows the same station name in a different building", async () => {
    await signInAsAdmin();
    for (const site of [siteId, otherSiteId]) {
      expect(
        (
          await createStation(
            json({
              siteId: site.toString(),
              niagaraStationName: "ZZTestShared",
              connectionMode: "direct",
              baseUrl: "https://198.51.100.8",
            }),
          )
        ).status,
      ).toBe(201);
    }
  });
});

// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------

describe("a station with history is not deleted out from under it", () => {
  it("refuses when it has points, and says the count", async () => {
    await signInAsAdmin();
    const station = await testDb.basStation.create({
      data: { siteId, niagaraStationName: "ZZTestWithPoints" },
    });
    await testDb.basPoint.createMany({
      data: [
        {
          stationId: station.stationId,
          niagaraHistoryName: "ZZTestP1",
          dataType: "real",
        },
        {
          stationId: station.stationId,
          niagaraHistoryName: "ZZTestP2",
          dataType: "real",
        },
      ],
    });

    const response = await deleteStation(
      json({}, "DELETE"),
      stationParams(station.stationId.toString()),
    );

    expect(response.status).toBe(409);
    const error = (await body(response)).error as {
      code?: string;
      message?: string;
    };
    expect(error.code).toBe("station_has_points");
    expect(error.message).toContain("2 points");
    // And it offers the thing the person actually wants.
    expect(error.message).toContain("inactive");

    expect(
      await testDb.basStation.findUnique({
        where: { stationId: station.stationId },
      }),
    ).not.toBeNull();
  });

  it("refuses when another station imports through it", async () => {
    await signInAsAdmin();
    const parent = await testDb.basStation.create({
      data: { siteId, niagaraStationName: "ZZTestParent" },
    });
    await testDb.basStation.create({
      data: {
        siteId,
        niagaraStationName: "ZZTestChild",
        connectionMode: "via_parent",
        parentStationId: parent.stationId,
      },
    });

    const response = await deleteStation(
      json({}, "DELETE"),
      stationParams(parent.stationId.toString()),
    );
    expect(response.status).toBe(409);
    expect(String(((await body(response)).error as { message?: string }).message)).toContain(
      "importing through it",
    );
  });

  it("deletes a bare station, and its credential goes with it", async () => {
    await signInAsAdmin();
    const station = await testDb.basStation.create({
      data: { siteId, niagaraStationName: "ZZTestBare" },
    });
    await setCredential(
      json({ username: "svc", password: "hunter2" }, "PUT"),
      stationParams(station.stationId.toString()),
    );
    expect(await testDb.basStationCredential.count()).toBe(1);

    expect(
      (
        await deleteStation(
          json({}, "DELETE"),
          stationParams(station.stationId.toString()),
        )
      ).status,
    ).toBe(200);

    expect(
      await testDb.basStation.findUnique({
        where: { stationId: station.stationId },
      }),
    ).toBeNull();
    // Cascade, not orphan. A deleted station must not leave a stored secret.
    expect(await testDb.basStationCredential.count()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// "Is it working" comes from the collector's own records
// ---------------------------------------------------------------------------

describe("station activity is derived, not tested live", () => {
  /**
   * There is no "test connection" button and there must not be. It would open a
   * socket from wherever the platform runs - fine on a laptop on the building
   * network, permanently broken once this is in Azure, which cannot reach the
   * building network and must not be able to.
   *
   * These three facts come from what the collector already wrote, so they are
   * true from anywhere.
   */
  it("reports the last collector run and the newest record", async () => {
    const station = await testDb.basStation.create({
      data: { siteId, niagaraStationName: "ZZTestActivity" },
    });
    const point = await testDb.basPoint.create({
      data: {
        stationId: station.stationId,
        niagaraHistoryName: "ZZTestActivityPoint",
        dataType: "real",
      },
    });

    const runAt = new Date("2026-09-01T10:00:00Z");
    const recordAt = new Date("2026-09-01T09:55:00Z");
    await testDb.basIngestRun.create({
      data: {
        stationId: station.stationId,
        startedAt: runAt,
        status: "ok",
        collectorHost: "ZZTEST-HOST",
      },
    });
    await testDb.basSyncCheckpoint.create({
      data: { pointId: point.pointId, lastRecordTs: recordAt, lastStatus: "ok" },
    });

    const tree = await getBasSettingsTree(await adminViewer());
    const row = tree.projects
      .flatMap((p) => p.buildings)
      .flatMap((b) => b.stations)
      .find((s) => s.niagaraStationName === "ZZTestActivity");

    expect(row?.activity.lastRunAt).toBe(runAt.toISOString());
    expect(row?.activity.lastRunStatus).toBe("ok");
    expect(row?.activity.newestRecordAt).toBe(recordAt.toISOString());
  });

  it("reports nulls for a station nothing has collected yet", async () => {
    await testDb.basStation.create({
      data: { siteId, niagaraStationName: "ZZTestNeverRun" },
    });

    const tree = await getBasSettingsTree(await adminViewer());
    const row = tree.projects
      .flatMap((p) => p.buildings)
      .flatMap((b) => b.stations)
      .find((s) => s.niagaraStationName === "ZZTestNeverRun");

    expect(row?.activity).toEqual({
      lastRunAt: null,
      lastRunStatus: null,
      newestRecordAt: null,
    });
  });

  /** No route anywhere opens a connection to a station. */
  it("exposes no test-connection route", async () => {
    const { readdir } = await import("node:fs/promises");
    const path = await import("node:path");
    const found: string[] = [];

    async function walk(dir: string): Promise<void> {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (/test|probe|ping|connect/i.test(entry.name)) found.push(full);
          await walk(full);
        }
      }
    }
    await walk(path.join(process.cwd(), "app/api/modules/bas/settings"));

    expect(found).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The tree still accounts for everything
// ---------------------------------------------------------------------------

describe("registering a station keeps the accounting honest", () => {
  it("counts every new station in stationsAccountedFor", async () => {
    await signInAsAdmin();
    await createStation(
      json({
        siteId: siteId.toString(),
        niagaraStationName: "ZZTestCounted",
        connectionMode: "direct",
        baseUrl: "https://198.51.100.12",
      }),
    );

    const response = await settingsTree(treeRequest());
    const payload = (await response.json()) as {
      data: { stationsAccountedFor: { rendered: number; inDatabase: number } };
    };

    expect(payload.data.stationsAccountedFor.rendered).toBe(
      payload.data.stationsAccountedFor.inDatabase,
    );
    expect(payload.data.stationsAccountedFor.inDatabase).toBe(
      await testDb.basStation.count(),
    );
  });
});
