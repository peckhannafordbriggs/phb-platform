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
