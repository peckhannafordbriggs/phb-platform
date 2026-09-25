import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// collection-health.tsx is a client component whose top-level hooks need a
// router; PointTable itself calls none of them, but the module has to import.
vi.mock("next/navigation", () => ({
  usePathname: () => "/bas",
  useRouter: () => ({ replace: () => undefined, push: () => undefined }),
  useSearchParams: () => new URLSearchParams(""),
}));

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Viewer } from "@/lib/authz";
import { getCollectionHealth } from "@/lib/modules/bas/service";
import { describeHiddenRisk, isAtRisk } from "@/lib/modules/bas/types";
import { PointTable } from "@/app/(modules)/bas/collection-health";
import { createHealthFixture, expectBasTablesEmpty, type HealthFixture } from "./bas-fixture";
import {
  createEmployee,
  disconnectDb,
  resetDb,
  seedBasModule,
  seedChangeOrdersModule,
  testDb,
} from "./db";

/**
 * The per-point table scrolls, and the figures do not follow the viewport.
 *
 * The container shows about seven rows and scrolls the rest, like the
 * collector runs and data gaps tables. That is one more way for the screen to
 * show less than it knows, so what is proved here is the same rule B8.3
 * proved for hidden points:
 *
 *   1. The count beside the heading is the number of rows in the container,
 *      and it matches the database, so nobody has to scroll to learn it.
 *   2. Every row is in the DOM. The container clips, it does not slice, and
 *      the at-risk figures, the hidden-risk sentence, the active count and
 *      the completeness counts are the service's numbers over ALL points -
 *      26 here, of which the viewport would show about seven.
 *   3. The header is sticky, so the columns stay named while the body moves.
 *   4. It is the SAME container the other two scrolling tables use, read off
 *      the source, so a second pattern cannot creep in.
 *
 * A static render cannot scroll, so "the list scrolls" is the container's
 * classes and the row count, and "the header stays put" is the thead's. Those
 * are the same assertions the two existing scroll tables rest on.
 *
 * 26 points: the seven the health fixture creates plus nineteen more on
 * station A with no capacity and no checkpoint, so every one of them is at
 * risk (never_collected) and the at-risk figure has to reach all of them.
 */

const EXTRA = 19;
const EXTRA_PREFIX = "ZZTEST_Scroll_";

let fixture: HealthFixture;
let viewer: Viewer;

async function viewCount(where: string): Promise<number> {
  const rows = await testDb.$queryRawUnsafe<Array<{ n: number }>>(
    `SELECT count(*)::int AS n FROM bas_v_collection_health WHERE ${where}`,
  );
  return rows[0]?.n ?? -1;
}

beforeEach(async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  await resetDb();
  await seedChangeOrdersModule();
  await seedBasModule();
  await expectBasTablesEmpty();
  fixture = await createHealthFixture();

  await testDb.basPoint.createMany({
    data: Array.from({ length: EXTRA }, (_, i) => ({
      stationId: fixture.stationId,
      niagaraHistoryName: `${EXTRA_PREFIX}${String(i + 1).padStart(2, "0")}`,
      dataType: "real",
    })),
  });

  const employee = await createEmployee({ entraOid: "oid-scroll" });
  viewer = {
    id: employee.id,
    email: employee.email,
    firstName: employee.firstName,
    lastName: employee.lastName,
    profileCompleted: true,
    isPlatformAdmin: false,
  };
});

afterEach(async () => {
  await testDb.basPoint.deleteMany({
    where: { niagaraHistoryName: { startsWith: EXTRA_PREFIX } },
  });
  await fixture.cleanup();
  vi.restoreAllMocks();
});

afterAll(async () => {
  await disconnectDb();
});

const render = (health: Awaited<ReturnType<typeof getCollectionHealth>>) =>
  renderToStaticMarkup(
    createElement(PointTable, { points: health.points, siteName: health.selectedSiteName }),
  );

const bodyRows = (html: string) =>
  (html.match(/<tbody>[\s\S]*<\/tbody>/)?.[0].match(/<tr/g) ?? []).length;

describe("the count beside the heading", () => {
  it("is the number of rows in the container, and matches the database", async () => {
    const health = await getCollectionHealth(viewer, {});
    const inDatabase = await viewCount("is_active");
    expect(inDatabase).toBe(7 + EXTRA);

    const html = render(health);
    expect(html).toContain("Per-point collection status");
    expect(html).toContain(`(${inDatabase})`);
    expect(bodyRows(html)).toBe(inDatabase);
  });

  it("counts the rows listed, and names the hidden ones beside it, while the totals hold", async () => {
    await testDb.basPoint.update({
      where: { pointId: fixture.unknown },
      data: { isVisible: false },
    });
    const health = await getCollectionHealth(viewer, {});
    const html = render(health);

    expect(html).toContain(`(${7 + EXTRA - 1})`);
    expect(bodyRows(html)).toBe(7 + EXTRA - 1);
    expect(html).toContain("1 hidden point");
    // The figures did not move: the hidden point is still in every one.
    expect(health.totals.activePoints).toBe(7 + EXTRA);
    expect(health.totals.hiddenPointsAtRisk).toBe(1);
  });
});

describe("the figures do not follow the viewport", () => {
  it("reports on all 26 points when the container would show about seven", async () => {
    const health = await getCollectionHealth(viewer, {});

    // The service's numbers, over every active point in the view.
    expect(health.totals.activePoints).toBe(7 + EXTRA);
    const atRiskInDatabase = await viewCount(
      "is_active AND roll_risk IN ('at_risk','data_lost','never_collected','roll_horizon_unknown')",
    );
    expect(atRiskInDatabase).toBeGreaterThan(7); // the nineteen extras, plus the fixture's
    expect(health.totals.pointsAtRisk).toBe(atRiskInDatabase);

    // And the rows the table holds agree with those numbers - every row, not
    // the first seven. Nothing between the service and the tbody drops one.
    expect(health.points).toHaveLength(7 + EXTRA);
    expect(health.points.filter((p) => isAtRisk(p.risk))).toHaveLength(atRiskInDatabase);
    expect(bodyRows(render(health))).toBe(7 + EXTRA);

    // Nothing hidden, so no sentence: the scroll container is not "hiding".
    expect(health.totals.hiddenPoints).toBe(0);
    expect(describeHiddenRisk(health)).toBeNull();

    // Completeness over all of them too: the nineteen have no checkpoint row.
    const unknown = Object.values(health.totals.completenessCounts).reduce((a, b) => a + b, 0);
    expect(unknown).toBe(7 + EXTRA);
  });

  it("never slices the points it was given (source text)", async () => {
    const source = await readFile(
      path.join(process.cwd(), "app", "(modules)", "bas", "collection-health.tsx"),
      "utf8",
    );
    // The table draws `points.map(...)` over the whole list. A `.slice(` on
    // the points inside PointTable would be a viewport deciding what is
    // drawn. Scoped to that function: the completeness card above it caps
    // the NAMES it lists at twelve, and its counts come from the totals.
    const start = source.indexOf("export function PointTable(");
    expect(start).toBeGreaterThan(0);
    const end = source.indexOf("\nfunction ", start);
    const table = source.slice(start, end === -1 ? undefined : end);
    expect(table).not.toMatch(/\.slice\(/);
    expect(table).toContain("points.map(");
  });
});

describe("the container", () => {
  it("scrolls within the panel, with the header sticky", async () => {
    const health = await getCollectionHealth(viewer, {});
    const html = render(health);
    // The table sits inside a capped, scrolling box...
    expect(html).toMatch(/<div class="max-h-72 overflow-auto"><table/);
    // ...whose header is sticky with its own background, so it stays put
    // and the rows do not show through it.
    expect(html).toMatch(/<thead class="sticky top-0 z-10 bg-\[var\(--surface\)\] text-left">/);
  });

  it("is the same container the collector runs and data gaps tables use (source text)", async () => {
    const source = await readFile(
      path.join(process.cwd(), "app", "(modules)", "bas", "collection-health.tsx"),
      "utf8",
    );
    // Three scrolling tables, one pattern: a max-h-* overflow-auto box with a
    // sticky thead. Count the boxes and the sticky headers; both are three.
    const boxes = source.match(/className="max-h-\d+ overflow-auto"/g) ?? [];
    expect(boxes).toHaveLength(3);
    const sticky = source.match(/<thead className="sticky top-0[^"]*bg-\[var\(--surface\)\]/g) ?? [];
    expect(sticky).toHaveLength(3);
    // And the points table uses the seven-row height the gaps table settled on.
    expect(source.match(/max-h-72 overflow-auto/g)).toHaveLength(2);
  });
});
