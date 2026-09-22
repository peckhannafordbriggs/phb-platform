import { Prisma } from "@/lib/generated/prisma/client";
import { testDb } from "./db";
import { expectBasTablesEmpty } from "./bas-fixture";
import roomT from "./fixtures/bas-live-points-roomt.json";
import opState from "./fixtures/bas-live-opstate.json";

/**
 * REAL readings, as a fixture.
 *
 * `tests/fixtures/bas-live-points-roomt.json` is every reading `bas_readings`
 * held for the Spring Grove lab's `points_RoomT` on 2026-09-22 - 7,831 rows at
 * five-minute cadence from 18 August, float32 values exactly as Niagara sent
 * them - together with the five `bas_data_gaps` rows recorded against it.
 * `bas-live-opstate.json` is the office's `OpState`: 301 change-of-value
 * records from 21 February 2024 to 8 September 2026, string-valued.
 *
 * Between them they carry the four things the custom-range tests need and a
 * synthetic series would have to fake: the 11-12 September 2026 hole and its
 * recorded gap; a zone temperature that read 76 and then -40 from 09:05 on 24
 * August 2026 onwards (a disconnected sensor - the extreme the downsampler
 * must not erase: a whole-day average of that day is about 4 degF);
 * readings on 9 March 2025, the day New York lost an hour; and an earliest
 * reading in 2024 so the year shortcuts have three years to offer.
 *
 * Extracted with one `COPY (SELECT json_build_object(...))` per point; the
 * `source` field in each file says when. They are sensor readings, not message
 * content - prohibition 8 is about the mailbox - and in the TEST database they
 * are not irreplaceable: they are these two files, loaded and deleted.
 *
 * COMMITTED, like `createHealthFixture`, because `getPointExplorer` reads
 * through the application's own client on its own connection and a fixture
 * inside an uncommitted transaction would be invisible to it. `cleanup()`
 * removes everything, and `expectBasTablesEmpty()` refuses to start otherwise.
 */

interface LiveReadingsFile {
  source: string;
  site: { name: string; timezone: string };
  point: {
    niagaraHistoryName: string;
    displayName: string;
    unit: string | null;
    dataType: string;
    collectionIntervalS: number | null;
    capacity: number | null;
  };
  gaps: Array<[number, number, string, string | null]>;
  /** `[epoch ms, value]` - a number for a numeric point, a string for an enum. */
  readings: Array<[number, number | string | null]>;
}

export const ROOM_T = roomT as unknown as LiveReadingsFile;
export const OP_STATE = opState as unknown as LiveReadingsFile;

/** The office station's clock offset as measured on 2026-09-22: 22 min 22 s ahead. */
export const OFFICE_CLOCK_OFFSET_S = 1342;

export interface LiveFixture {
  orgId: bigint;
  projectId: bigint;
  /** Spring Grove: `points_RoomT`, clock in step. */
  labSiteId: bigint;
  labStationId: bigint;
  roomT: bigint;
  /** Steel Place: `OpState`, clock 22 minutes ahead. */
  officeSiteId: bigint;
  officeStationId: bigint;
  opState: bigint;
  cleanup: () => Promise<void>;
}

export async function createLiveFixture(): Promise<LiveFixture> {
  await expectBasTablesEmpty();

  const base = await testDb.$transaction(async (tx) => {
    const org = await tx.basOrg.create({ data: { name: "ZZTEST_ORG_LIVE" } });
    const project = await tx.basProject.create({
      data: { orgId: org.orgId, name: "ZZTEST_PROJECT_LIVE" },
    });

    const lab = await tx.basSite.create({
      data: {
        orgId: org.orgId,
        projectId: project.projectId,
        name: ROOM_T.site.name,
        timezone: ROOM_T.site.timezone,
      },
    });
    const labStation = await tx.basStation.create({
      data: {
        siteId: lab.siteId,
        niagaraStationName: "SpringGroveLabComputer",
        clockOffsetS: 0,
        clockMeasuredAt: new Date("2026-09-22T18:20:46.713Z"),
      },
    });

    const office = await tx.basSite.create({
      data: {
        orgId: org.orgId,
        projectId: project.projectId,
        name: OP_STATE.site.name,
        timezone: OP_STATE.site.timezone,
      },
    });
    const officeStation = await tx.basStation.create({
      data: {
        siteId: office.siteId,
        niagaraStationName: "PHBoffice",
        clockOffsetS: OFFICE_CLOCK_OFFSET_S,
        clockMeasuredAt: new Date("2026-09-22T18:20:50.160Z"),
      },
    });

    const point = async (stationId: bigint, file: LiveReadingsFile) =>
      (
        await tx.basPoint.create({
          data: {
            stationId,
            niagaraHistoryName: file.point.niagaraHistoryName,
            niagaraDisplayName: file.point.displayName,
            unit: file.point.unit,
            dataType: file.point.dataType,
            capacity: file.point.capacity,
            collectionIntervalS: file.point.collectionIntervalS,
            fullPolicy: "roll",
          },
        })
      ).pointId;

    return {
      orgId: org.orgId,
      projectId: project.projectId,
      labSiteId: lab.siteId,
      labStationId: labStation.stationId,
      roomT: await point(labStation.stationId, ROOM_T),
      officeSiteId: office.siteId,
      officeStationId: officeStation.stationId,
      opState: await point(officeStation.stationId, OP_STATE),
    };
  });

  await loadReadings(base.roomT, ROOM_T);
  await loadReadings(base.opState, OP_STATE);

  for (const [startMs, endMs, cause, notes] of ROOM_T.gaps) {
    await testDb.basDataGap.create({
      data: {
        pointId: base.roomT,
        gapStart: new Date(startMs),
        gapEnd: new Date(endMs),
        cause,
        notes,
      },
    });
  }

  const cleanup = async () => {
    // Readings and gaps cascade from bas_points.
    await testDb.basPoint.deleteMany({
      where: { stationId: { in: [base.labStationId, base.officeStationId] } },
    });
    await testDb.basStation.deleteMany({
      where: { siteId: { in: [base.labSiteId, base.officeSiteId] } },
    });
    await testDb.basSite.deleteMany({
      where: { siteId: { in: [base.labSiteId, base.officeSiteId] } },
    });
    await testDb.basProject.deleteMany({ where: { projectId: base.projectId } });
    await testDb.basOrg.deleteMany({ where: { orgId: base.orgId } });
  };

  return { ...base, cleanup };
}

/**
 * Multi-row VALUES in chunks. Seven thousand single-row inserts through the
 * client take long enough to trip the hook timeout; eight statements do not.
 */
async function loadReadings(pointId: bigint, file: LiveReadingsFile): Promise<void> {
  const CHUNK = 1000;
  for (let i = 0; i < file.readings.length; i += CHUNK) {
    const rows = file.readings.slice(i, i + CHUNK).map(([ms, value]) => {
      const num = typeof value === "number" ? value : null;
      const str = typeof value === "string" ? value : null;
      return Prisma.sql`(${pointId}, ${new Date(ms)}, ${num}::float8, ${str}::text)`;
    });
    await testDb.$executeRaw`
      INSERT INTO bas_readings (point_id, ts, value_num, value_str)
      VALUES ${Prisma.join(rows)}
    `;
  }
}

/** Readings from a file that fall in `[fromMs, toMs)` - the test's own count. */
export function readingsBetween(
  file: LiveReadingsFile,
  fromMs: number,
  toMs: number,
): Array<[number, number | string | null]> {
  return file.readings.filter(([ms]) => ms >= fromMs && ms < toMs);
}
