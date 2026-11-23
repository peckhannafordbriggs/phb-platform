import { Prisma } from "@/lib/generated/prisma/client";
import { testDb } from "./db";
import { expectBasTablesEmpty } from "./bas-fixture";

/**
 * A station shaped like CEI_JCI_N2 (2026-11-20): interval histories reporting
 * every 30 minutes, NOTHING entered from Workbench - no capacity, no
 * interval - and the station reporting no record count. The shape that read
 * "334 points at risk" and drew 280 breaks a week per point.
 *
 *   spaceTemp    V4_22/SpaceTemp, zone_temp, °F, every 30 min for 8 days,
 *                with one 3-hour hole (5 readings missing) 2 days ago
 *   spaceTempSp  V4_22/SpaceTempSp, °F, every 30 min, always 72 - a flat
 *                value, for the stuck-sensor line and a shared axis
 *   damper       V4_22/DamperPos, percent, every 30 min - another unit, for
 *                a second axis
 *   occ          V4_22/Occ, boolean, change-of-value - uneven gaps
 *   otherOat     on ANOTHER station - not offered to compare
 *
 * Committed, like the other BAS fixtures, because the service reads through
 * the application's own client. `cleanup()` removes every row it made, the
 * zone_temp role included when it made it.
 */

export const HALF_HOUR_MS = 30 * 60_000;
export const CEI_DAYS = 8;

export interface CeiFixture {
  orgId: bigint;
  projectId: bigint;
  siteId: bigint;
  stationId: bigint;
  otherStationId: bigint;
  equipmentId: bigint;
  spaceTemp: bigint;
  spaceTempSp: bigint;
  damper: bigint;
  occ: bigint;
  otherOat: bigint;
  /** The newest reading on the 30-minute points. */
  newestMs: number;
  /** The hole in spaceTemp: the last reading before it and the first after. */
  hole: { fromMs: number; toMs: number };
  cleanup: () => Promise<void>;
}

/** The value a 30-minute point reads at an instant: a daily swing about 71 °F. */
export function spaceTempAt(ms: number): number {
  return Math.round((71 + 2 * Math.sin((ms / 86_400_000) * 2 * Math.PI)) * 10) / 10;
}

export async function createCeiFixture(): Promise<CeiFixture> {
  await expectBasTablesEmpty();
  const createdRole = (await testDb.basPointRole.findUnique({ where: { pointRole: "zone_temp" } })) === null;
  if (createdRole) {
    await testDb.basPointRole.create({
      data: {
        pointRole: "zone_temp",
        displayName: "Zone temperature",
        description: "Fixture role, the vocabulary's own key.",
        measurement: "temperature",
        typicalUnit: "fahrenheit",
      },
    });
  }

  const org = await testDb.basOrg.create({ data: { name: "ZZTEST_ORG_CEI" } });
  const project = await testDb.basProject.create({ data: { orgId: org.orgId, name: "ZZTEST_PROJECT_CEI" } });
  const site = await testDb.basSite.create({
    data: { orgId: org.orgId, projectId: project.projectId, name: "ZZTEST CEI", timezone: "America/New_York" },
  });
  const station = await testDb.basStation.create({
    data: { siteId: site.siteId, niagaraStationName: "ZZTEST_CEI_JCI_N2", connectionMode: "direct", baseUrl: "https://198.51.100.40" },
  });
  const other = await testDb.basStation.create({
    data: { siteId: site.siteId, niagaraStationName: "ZZTEST_CEI_OTHER", connectionMode: "direct", baseUrl: "https://198.51.100.41" },
  });
  const equipment = await testDb.basEquipment.create({ data: { siteId: site.siteId, name: "V4_22" } });

  const point = async (
    stationId: bigint,
    name: string,
    opts: { unit: string | null; dataType: string; role?: string | null; equipmentId?: bigint | null },
  ) =>
    (
      await testDb.basPoint.create({
        data: {
          stationId,
          niagaraHistoryName: name,
          unit: opts.unit,
          dataType: opts.dataType,
          pointRole: opts.role ?? null,
          equipmentId: opts.equipmentId ?? null,
          capacity: null,
          collectionIntervalS: null,
          fullPolicy: "roll",
        },
      })
    ).pointId;

  const spaceTemp = await point(station.stationId, "V4_22/SpaceTemp", {
    unit: "fahrenheit",
    dataType: "real",
    role: "zone_temp",
    equipmentId: equipment.equipmentId,
  });
  const spaceTempSp = await point(station.stationId, "V4_22/SpaceTempSp", {
    unit: "fahrenheit",
    dataType: "real",
    equipmentId: equipment.equipmentId,
  });
  const damper = await point(station.stationId, "V4_22/DamperPos", {
    unit: "percent",
    dataType: "real",
    equipmentId: equipment.equipmentId,
  });
  const occ = await point(station.stationId, "V4_22/Occ", { unit: null, dataType: "bool", equipmentId: equipment.equipmentId });
  const otherOat = await point(other.stationId, "Other/OAT", { unit: "fahrenheit", dataType: "real" });

  // 30-minute readings, newest ten minutes ago, aligned to the half hour.
  const now = Date.now();
  const newestMs = Math.floor((now - 10 * 60_000) / HALF_HOUR_MS) * HALF_HOUR_MS;
  const count = (CEI_DAYS * 86_400_000) / HALF_HOUR_MS;
  const stamps = Array.from({ length: count }, (_, i) => newestMs - (count - 1 - i) * HALF_HOUR_MS);
  // The hole: five readings missing two days ago.
  const holeStart = stamps.length - 96;
  const holed = stamps.filter((_, i) => i < holeStart || i > holeStart + 4);
  const hole = { fromMs: stamps[holeStart - 1]!, toMs: stamps[holeStart + 5]! };

  const insert = async (pointId: bigint, rows: Array<[number, number | null, boolean | null]>) => {
    for (let i = 0; i < rows.length; i += 1000) {
      const chunk = rows.slice(i, i + 1000);
      await testDb.$executeRaw`
        INSERT INTO bas_readings (point_id, ts, value_num, value_bool)
        VALUES ${Prisma.join(chunk.map(([ms, n, b]) => Prisma.sql`(${pointId}, ${new Date(ms)}, ${n}, ${b})`))}`;
    }
  };
  await insert(spaceTemp, holed.map((ms) => [ms, spaceTempAt(ms), null]));
  await insert(spaceTempSp, stamps.map((ms) => [ms, 72, null]));
  await insert(damper, stamps.map((ms, i) => [ms, 20 + (i % 10) * 5, null]));
  await insert(otherOat, stamps.map((ms) => [ms, 40, null]));
  // Change of value: gaps from 7 minutes to 14 hours, nothing regular.
  const covGaps = [7, 300, 45, 840, 12, 600, 90, 33, 420, 180, 15, 510, 75, 260, 20, 700];
  const covStamps: number[] = [];
  let t = newestMs - 7 * 86_400_000;
  for (const g of covGaps) {
    t += g * 60_000;
    covStamps.push(t);
  }
  await insert(occ, covStamps.map((ms, i) => [ms, null, i % 2 === 0]));

  // Checkpoints as the collector leaves them for CEI: collected, no count.
  for (const [pointId, lastMs] of [
    [spaceTemp, newestMs],
    [spaceTempSp, newestMs],
    [damper, newestMs],
    [occ, covStamps.at(-1)!],
    [otherOat, newestMs],
  ] as const) {
    await testDb.basSyncCheckpoint.create({
      data: { pointId, lastRecordTs: new Date(lastMs), lastRunAt: new Date(now), lastStatus: "ok" },
    });
  }

  const cleanup = async () => {
    // Readings, checkpoints and trend summaries cascade from bas_points.
    await testDb.basPoint.deleteMany({ where: { stationId: { in: [station.stationId, other.stationId] } } });
    await testDb.basEquipment.deleteMany({ where: { siteId: site.siteId } });
    await testDb.basStation.deleteMany({ where: { siteId: site.siteId } });
    await testDb.basSite.deleteMany({ where: { siteId: site.siteId } });
    await testDb.basProject.deleteMany({ where: { projectId: project.projectId } });
    await testDb.basOrg.deleteMany({ where: { orgId: org.orgId } });
    if (createdRole) await testDb.basPointRole.deleteMany({ where: { pointRole: "zone_temp" } });
  };

  return {
    orgId: org.orgId,
    projectId: project.projectId,
    siteId: site.siteId,
    stationId: station.stationId,
    otherStationId: other.stationId,
    equipmentId: equipment.equipmentId,
    spaceTemp,
    spaceTempSp,
    damper,
    occ,
    otherOat,
    newestMs,
    hole,
    cleanup,
  };
}

// ---------------------------------------------------------------------------
// CEI with its via-parent stations: the duplicate copies (2026-11-23)
// ---------------------------------------------------------------------------

/**
 * CEI_JCI_N2 as it holds its histories - the 334 real names from
 * docs/fixtures/cei-point-names.txt, oBIX-escaped (`/` as `$2f`) - with two
 * via-parent stations under it on the same building, CEI_AHU_7 and CEI_AHU_8,
 * as the collector reads them since 2026-11-20.
 *
 * The JACE's `AHU_7/*` and `AHU_8/*` histories are its dead copies: every 30
 * minutes for eight days they log 0 (a number) or false (the two fan
 * statuses). Each via-parent station holds the same measurements under the
 * bare name - `DA_SAP`, `MA_T`, `OA_H` - and they are live: a different value
 * almost every reading, the fan statuses cycling on and off. The child
 * stations' point lists are the parent's tails: what CEI_AHU_7 really holds
 * was not read for this fixture.
 *
 * Nothing else carries readings; the 155 VAVs are names only. `cleanup()`
 * removes everything it made; readings cascade from bas_points.
 */
export type SeriesKind = "flat" | "live" | "bool_flat" | "bool_cycle";

export const CEI_COPY_TAILS: Readonly<Record<"AHU_7" | "AHU_8", readonly string[]>> = {
  AHU_7: ["DA_SAP", "DA_T", "MA_T", "OA_Enth", "OA_H", "OA_T", "RA_Enth", "RA_HUM", "RA_T", "RF_S", "SF_S"],
  AHU_8: ["OA_H", "RA_Enth", "RA_HUM"],
};
const BOOL_TAILS = new Set(["RF_S", "SF_S"]);

export interface CeiDuplicateFixture {
  orgId: bigint;
  projectId: bigint;
  siteId: bigint;
  jaceId: bigint;
  ahu7Id: bigint;
  ahu8Id: bigint;
  /** "CEI_JCI_N2:AHU_7/DA_SAP" or "CEI_AHU_7:DA_SAP" -> point id. Names decoded. */
  ids: Map<string, bigint>;
  /** The newest reading's instant on every series. */
  newestMs: number;
  /** Replace a point's readings with a series of this kind. */
  setSeries: (pointId: bigint, kind: SeriesKind) => Promise<void>;
  /** One more point on a station, with a series. */
  addPoint: (stationId: bigint, name: string, kind: SeriesKind) => Promise<bigint>;
  cleanup: () => Promise<void>;
}

export const ceiEscape = (name: string) => name.replace(/\//g, "$2f").replace(/-/g, "$2d");

export async function createCeiDuplicateFixture(names: readonly string[]): Promise<CeiDuplicateFixture> {
  await expectBasTablesEmpty();
  const org = await testDb.basOrg.create({ data: { name: "ZZTEST_ORG_CEI_COPIES" } });
  const project = await testDb.basProject.create({ data: { orgId: org.orgId, name: "ZZTEST_PROJECT_CEI_COPIES" } });
  const site = await testDb.basSite.create({
    data: { orgId: org.orgId, projectId: project.projectId, name: "ZZTEST CEI", timezone: "America/New_York" },
  });
  const jace = await testDb.basStation.create({
    data: { siteId: site.siteId, niagaraStationName: "CEI_JCI_N2", connectionMode: "direct", baseUrl: "https://198.51.100.40" },
  });
  const child = (name: string) =>
    testDb.basStation.create({
      data: { siteId: site.siteId, niagaraStationName: name, connectionMode: "via_parent", parentStationId: jace.stationId },
    });
  const ahu7 = await child("CEI_AHU_7");
  const ahu8 = await child("CEI_AHU_8");

  const now = Date.now();
  const newestMs = Math.floor((now - 10 * 60_000) / HALF_HOUR_MS) * HALF_HOUR_MS;
  const count = (CEI_DAYS * 86_400_000) / HALF_HOUR_MS;
  const stamps = Array.from({ length: count }, (_, i) => newestMs - (count - 1 - i) * HALF_HOUR_MS);

  const setSeries = async (pointId: bigint, kind: SeriesKind) => {
    await testDb.$executeRaw`DELETE FROM bas_readings WHERE point_id = ${pointId}`;
    const rows = stamps.map((ms, i): [number, number | null, boolean | null] => {
      switch (kind) {
        case "flat":
          return [ms, 0, null];
        case "live":
          // A daily swing with a little noise: hundreds of distinct values.
          return [ms, Math.round((1.2 + 0.4 * Math.sin((ms / 86_400_000) * 2 * Math.PI) + (i % 7) * 0.01) * 1000) / 1000, null];
        case "bool_flat":
          return [ms, null, false];
        case "bool_cycle":
          return [ms, null, Math.floor(i / 4) % 2 === 0];
      }
    });
    for (let i = 0; i < rows.length; i += 1000) {
      const chunk = rows.slice(i, i + 1000);
      await testDb.$executeRaw`
        INSERT INTO bas_readings (point_id, ts, value_num, value_bool)
        VALUES ${Prisma.join(chunk.map(([ms, n, b]) => Prisma.sql`(${pointId}, ${new Date(ms)}, ${n}, ${b})`))}`;
    }
  };

  const ids = new Map<string, bigint>();
  const stationName = new Map([
    [jace.stationId, "CEI_JCI_N2"],
    [ahu7.stationId, "CEI_AHU_7"],
    [ahu8.stationId, "CEI_AHU_8"],
  ]);
  const addPoint = async (stationId: bigint, name: string, kind: SeriesKind) => {
    const bool = kind === "bool_flat" || kind === "bool_cycle";
    const pointId = (
      await testDb.basPoint.create({
        data: {
          stationId,
          niagaraHistoryName: ceiEscape(name),
          dataType: bool ? "bool" : "real",
          unit: !bool && /SAP$/i.test(name) ? "inches of water" : null,
        },
      })
    ).pointId;
    ids.set(`${stationName.get(stationId)}:${name}`, pointId);
    await setSeries(pointId, kind);
    return pointId;
  };

  // The JACE's 334 names; the AHU copies get their flat series below.
  const copyNames = new Set(
    (Object.entries(CEI_COPY_TAILS) as Array<[string, readonly string[]]>).flatMap(([unit, tails]) => tails.map((t) => `${unit}/${t}`)),
  );
  await testDb.basPoint.createMany({
    data: names
      .filter((n) => !copyNames.has(n))
      .map((name) => ({ stationId: jace.stationId, niagaraHistoryName: ceiEscape(name) })),
  });
  for (const p of await testDb.basPoint.findMany({ where: { stationId: jace.stationId }, select: { pointId: true, niagaraHistoryName: true } })) {
    ids.set(`CEI_JCI_N2:${p.niagaraHistoryName.replace(/\$2f/g, "/").replace(/\$2d/g, "-")}`, p.pointId);
  }
  for (const [unit, tails] of Object.entries(CEI_COPY_TAILS) as Array<["AHU_7" | "AHU_8", readonly string[]]>) {
    const childId = unit === "AHU_7" ? ahu7.stationId : ahu8.stationId;
    for (const tail of tails) {
      const bool = BOOL_TAILS.has(tail);
      await addPoint(jace.stationId, `${unit}/${tail}`, bool ? "bool_flat" : "flat");
      await addPoint(childId, tail, bool ? "bool_cycle" : "live");
    }
  }

  const cleanup = async () => {
    const stations = [jace.stationId, ahu7.stationId, ahu8.stationId];
    // One statement, so duplicate_of between them never blocks the delete.
    await testDb.basPoint.deleteMany({ where: { stationId: { in: stations } } });
    await testDb.basEquipment.deleteMany({ where: { siteId: site.siteId } });
    await testDb.basStation.deleteMany({ where: { stationId: { in: [ahu7.stationId, ahu8.stationId] } } });
    await testDb.basStation.deleteMany({ where: { stationId: jace.stationId } });
    await testDb.basSite.deleteMany({ where: { siteId: site.siteId } });
    await testDb.basProject.deleteMany({ where: { projectId: project.projectId } });
    await testDb.basOrg.deleteMany({ where: { orgId: org.orgId } });
  };

  return {
    orgId: org.orgId,
    projectId: project.projectId,
    siteId: site.siteId,
    jaceId: jace.stationId,
    ahu7Id: ahu7.stationId,
    ahu8Id: ahu8.stationId,
    ids,
    newestMs,
    setSeries,
    addPoint,
    cleanup,
  };
}

// ---------------------------------------------------------------------------
// CEI with its REAL controllers (2026-11-23)
// ---------------------------------------------------------------------------

/**
 * CEI as production holds it: CEI_JCI_N2's 334 names
 * (docs/fixtures/cei-point-names.txt) and its three via-parent controllers
 * with their real names, units and data types
 * (docs/fixtures/cei-controller-point-names.txt, read from production on
 * 2026-11-23).
 *
 * Readings, every 30 minutes for eight days:
 *   - the JACE's `AHU_7/*` and `AHU_8/*` copies: 0, a number, with NO unit
 *     and data type `real` - what the three JACE points read from production
 *     carry, and the case a "both unitless" unit rule would refuse;
 *   - every controller point: live - a number that moves every reading, or
 *     for a boolean, on and off every two hours;
 *   - nothing else (the VAVs are names only).
 *
 * The roles and equipment are NOT written here: the test runs the
 * assignment pass first (vocabularies seeded), as production did, so the
 * copies and the controllers' points meet on AHU_7 and AHU_8 by the station
 * rule. `cleanup()` removes what it made; readings cascade.
 */
export interface CeiControllerFixture {
  siteId: bigint;
  jaceId: bigint;
  stationIds: Map<string, bigint>;
  /** "CEI_JCI_N2:AHU_7/MA_T", "CEI_AHU_7:AHU_7_Ma_Temp" -> point id. Names decoded. */
  ids: Map<string, bigint>;
  setSeries: (pointId: bigint, kind: SeriesKind) => Promise<void>;
  cleanup: () => Promise<void>;
}

export async function createCeiControllerFixture(
  jaceNames: readonly string[],
  controllers: ReadonlyArray<{ station: string; name: string; unit: string | null; dataType: string }>,
): Promise<CeiControllerFixture> {
  await expectBasTablesEmpty();
  const org = await testDb.basOrg.create({ data: { name: "ZZTEST_ORG_CEI_REAL" } });
  const project = await testDb.basProject.create({ data: { orgId: org.orgId, name: "ZZTEST_PROJECT_CEI_REAL" } });
  const site = await testDb.basSite.create({
    data: { orgId: org.orgId, projectId: project.projectId, name: "ZZTEST CEI", timezone: "America/New_York" },
  });
  const jace = await testDb.basStation.create({
    data: { siteId: site.siteId, niagaraStationName: "CEI_JCI_N2", connectionMode: "direct", baseUrl: "https://198.51.100.40" },
  });
  const stationIds = new Map<string, bigint>([["CEI_JCI_N2", jace.stationId]]);
  for (const name of [...new Set(controllers.map((c) => c.station))].filter((n) => n !== "CEI_JCI_N2").sort()) {
    const child = await testDb.basStation.create({
      data: { siteId: site.siteId, niagaraStationName: name, connectionMode: "via_parent", parentStationId: jace.stationId },
    });
    stationIds.set(name, child.stationId);
  }

  const now = Date.now();
  const newestMs = Math.floor((now - 10 * 60_000) / HALF_HOUR_MS) * HALF_HOUR_MS;
  const count = (CEI_DAYS * 86_400_000) / HALF_HOUR_MS;
  const stamps = Array.from({ length: count }, (_, i) => newestMs - (count - 1 - i) * HALF_HOUR_MS);
  const setSeries = async (pointId: bigint, kind: SeriesKind) => {
    await testDb.$executeRaw`DELETE FROM bas_readings WHERE point_id = ${pointId}`;
    const rows = stamps.map((ms, i): [number, number | null, boolean | null] => {
      switch (kind) {
        case "flat":
          return [ms, 0, null];
        case "live":
          return [ms, Math.round((50 + 10 * Math.sin((ms / 86_400_000) * 2 * Math.PI) + (i % 7) * 0.1 + Number(pointId % 13n)) * 100) / 100, null];
        case "bool_flat":
          return [ms, null, false];
        case "bool_cycle":
          return [ms, null, Math.floor(i / 4) % 2 === 0];
      }
    });
    await testDb.$executeRaw`
      INSERT INTO bas_readings (point_id, ts, value_num, value_bool)
      VALUES ${Prisma.join(rows.map(([ms, n, b]) => Prisma.sql`(${pointId}, ${new Date(ms)}, ${n}, ${b})`))}`;
  };

  const ids = new Map<string, bigint>();
  await testDb.basPoint.createMany({
    data: jaceNames.map((name) => ({ stationId: jace.stationId, niagaraHistoryName: ceiEscape(name), dataType: "real" })),
  });
  for (const c of controllers) {
    const stationId = stationIds.get(c.station)!;
    const existing = c.station === "CEI_JCI_N2";
    if (existing) continue; // the JACE's own rows came from its 334 names
    await testDb.basPoint.create({
      data: { stationId, niagaraHistoryName: ceiEscape(c.name), unit: c.unit, dataType: c.dataType },
    });
  }
  const nameOf = new Map([...stationIds.entries()].map(([name, id]) => [id.toString(), name]));
  for (const p of await testDb.basPoint.findMany({
    where: { stationId: { in: [...stationIds.values()] } },
    select: { pointId: true, stationId: true, niagaraHistoryName: true, dataType: true },
  })) {
    const name = p.niagaraHistoryName.replace(/\$2f/g, "/").replace(/\$2d/g, "-");
    const station = nameOf.get(p.stationId.toString())!;
    ids.set(`${station}:${name}`, p.pointId);
    if (station === "CEI_JCI_N2") {
      if (/^AHU_[78]\//.test(name)) await setSeries(p.pointId, "flat");
    } else {
      await setSeries(p.pointId, p.dataType === "bool" ? "bool_cycle" : "live");
    }
  }

  const cleanup = async () => {
    const all = [...stationIds.values()];
    await testDb.basPoint.deleteMany({ where: { stationId: { in: all } } });
    await testDb.basEquipment.deleteMany({ where: { siteId: site.siteId } });
    await testDb.basStation.deleteMany({ where: { stationId: { in: all.filter((id) => id !== jace.stationId) } } });
    await testDb.basStation.deleteMany({ where: { stationId: jace.stationId } });
    await testDb.basSite.deleteMany({ where: { siteId: site.siteId } });
    await testDb.basProject.deleteMany({ where: { projectId: project.projectId } });
    await testDb.basOrg.deleteMany({ where: { orgId: org.orgId } });
  };

  return { siteId: site.siteId, jaceId: jace.stationId, stationIds, ids, setSeries, cleanup };
}
