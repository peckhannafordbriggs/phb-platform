import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "next-auth";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("@/auth", () => ({ auth: vi.fn() }));

import { auth } from "@/auth";
import type { Viewer } from "@/lib/authz";
import { DECORATIVE_CARD_FILLS, decorativeCardFill } from "@/lib/module-accent";
import { BAS_MODULE_KEY } from "@/lib/modules/bas/constants";
import { resetBasAvailabilityCache } from "@/lib/modules/bas/route-helpers";
import { getDashboard } from "@/lib/modules/bas/service";
import type { BasDashboard, DashboardProject, RollRisk } from "@/lib/modules/bas/types";
import { DashboardCards } from "@/app/(modules)/bas/dashboard";
import { projectFills } from "@/app/(modules)/bas/project-colours";
import {
  createEmployee,
  disconnectDb,
  grantModule,
  resetDb,
  seedBasModule,
  seedChangeOrdersModule,
  testDb,
} from "./db";

/**
 * The Projects tab's cards are filled in brand colours (2026-09-30), and the
 * colour means nothing.
 *
 * Three things are held here, and the third is the one that matters:
 *
 *   1. A project's fill is stable: the same across renders, the same
 *      whatever its health, assigned by creation order so a new project takes
 *      the next colour and nobody else's changes.
 *   2. The palette is legible: full-white text clears AA on every fill, the
 *      mark's white edge clears 3:1 against every fill, and the mark's own
 *      words clear AA on maroon - asserted from the tokens in globals.css,
 *      not from pixels.
 *   3. Colour is never semantic: no fill is red or maroon, the fill is
 *      computed from nothing but ids, and a colour-blind reader tells a
 *      healthy card from an at-risk one by the boxed words alone.
 *
 * MUTATION, run 2026-09-30 and restored: the component handed each card
 * `decorativeCardFill(project.health?.pointsAtRisk ?? 0)` instead of its
 * rank -> 2 failures here, "does not change with its health" and "follows
 * creation order, not display order"; 13 passed, the palette measurements
 * among them, because the palette itself was untouched.
 */

const authMock = vi.mocked(auth);

function signedInAs(entraOid: string) {
  authMock.mockResolvedValue({
    entraOid,
    issuedAt: Math.floor(Date.now() / 1000),
    user: {},
    expires: new Date(Date.now() + 3_600_000).toISOString(),
  } as unknown as Session as never);
}

// ------------------------------------------------------------------ contrast

const hex = (value: string): [number, number, number] => {
  const clean = value.replace("#", "");
  return [0, 2, 4].map((i) => parseInt(clean.slice(i, i + 2), 16)) as [number, number, number];
};
const channel = (c: number): number => {
  const v = c / 255;
  return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
};
const luminance = (rgb: [number, number, number]): number =>
  0.2126 * channel(rgb[0]) + 0.7152 * channel(rgb[1]) + 0.0722 * channel(rgb[2]);
const contrast = (a: string, b: string): number => {
  const [l1, l2] = [luminance(hex(a)), luminance(hex(b))];
  const [hi, lo] = l1 > l2 ? [l1, l2] : [l2, l1];
  return (hi + 0.05) / (lo + 0.05);
};

const WHITE = "#ffffff";
const AA_TEXT = 4.5;
const AA_NON_TEXT = 3;

/** The brand tokens, read from the stylesheet rather than restated here. */
async function tokens(): Promise<Record<string, string>> {
  const css = await readFile(path.join(process.cwd(), "app/globals.css"), "utf8");
  const out: Record<string, string> = {};
  for (const [, name, value] of css.matchAll(/(--phb-[a-z-]+):\s*(#[0-9a-f]{6})/gi)) {
    out[name!] = value!;
  }
  return out;
}

/** `var(--phb-x)` -> `--phb-x`. Every palette entry must have this shape. */
const tokenName = (fill: string): string => {
  const m = /^var\((--phb-[a-z-]+)\)$/.exec(fill);
  if (m === null) throw new Error(`not a token reference: ${fill}`);
  return m[1]!;
};

// ------------------------------------------------------------------ fixtures

const risks = (over: Partial<Record<RollRisk, number>> = {}): Record<RollRisk, number> => ({
  ok: 0,
  at_risk: 0,
  data_lost: 0,
  buffer_not_full: 0,
  roll_horizon_unknown: 0,
  never_collected: 0,
  ...over,
});

const project = (over: Partial<DashboardProject>): DashboardProject => ({
  projectId: "1",
  name: "Liberty Center",
  orgName: "PH+B",
  buildings: 2,
  stations: 2,
  health: { activePoints: 26, pointsAtRisk: 0, riskCounts: risks({ ok: 26 }), minutesSinceNewestReading: 4 },
  ...over,
});

const payload = (projects: DashboardProject[]): BasDashboard => ({
  observedAt: "2026-09-30T12:00:00.000Z",
  projects,
  projectsInDatabase: projects.length,
});

const render = (data: BasDashboard) =>
  renderToStaticMarkup(createElement(DashboardCards, { data, canAdminister: false }));

/** Card fills as rendered, keyed by the project name in the card. */
function renderedFills(html: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of html.matchAll(
    /data-testid="bas-dashboard-card"[^>]*data-fill="([^"]+)"[^>]*>[\s\S]*?<h2[^>]*>([^<]+)<\/h2>/g,
  )) {
    out.set(m[2]!, m[1]!);
  }
  // A card may carry data-fill before data-testid; match that order too.
  for (const m of html.matchAll(
    /data-fill="([^"]+)"[^>]*data-testid="bas-dashboard-card"[^>]*>[\s\S]*?<h2[^>]*>([^<]+)<\/h2>/g,
  )) {
    out.set(m[2]!, m[1]!);
  }
  return out;
}

// =============================================================================
// 2. The palette is legible, from the tokens
// =============================================================================

describe("the palette, measured from the tokens", () => {
  it("is made of token references only - no hex, no rgb - each defined in globals.css", async () => {
    const t = await tokens();
    expect(DECORATIVE_CARD_FILLS.length).toBeGreaterThanOrEqual(6);
    for (const fill of DECORATIVE_CARD_FILLS) {
      expect(t[tokenName(fill)], `${fill} is not a token in app/globals.css`).toBeDefined();
    }
    expect(new Set(DECORATIVE_CARD_FILLS).size).toBe(DECORATIVE_CARD_FILLS.length);
  });

  it("clears AA for full-white text on every fill", async () => {
    const t = await tokens();
    for (const fill of DECORATIVE_CARD_FILLS) {
      const value = t[tokenName(fill)]!;
      expect(contrast(WHITE, value), `white on ${fill} (${value})`).toBeGreaterThanOrEqual(AA_TEXT);
    }
  });

  it("would NOT clear AA at Home's 85% white on the inks, which is why the cards use full white", async () => {
    // Not a rule about Home. A record of the measurement that made this
    // screen's text full white: on the ink fills, white at 85% opacity is
    // between 3.8 and 4.1.
    const t = await tokens();
    const mix = (top: string, base: string, k: number): string => {
      const [a, b] = [hex(top), hex(base)];
      return `#${a.map((c, i) => Math.round(k * c + (1 - k) * b[i]!).toString(16).padStart(2, "0")).join("")}`;
    };
    const inks = DECORATIVE_CARD_FILLS.filter((f) => f.endsWith("-ink)"));
    expect(inks.length).toBeGreaterThan(0);
    for (const fill of inks) {
      const value = t[tokenName(fill)]!;
      expect(contrast(mix(WHITE, value, 0.85), value)).toBeLessThan(AA_TEXT);
    }
  });

  it("the mark reads on every fill by its white edge and its white words, not by its maroon", async () => {
    const t = await tokens();
    const maroon = t["--phb-maroon"]!;
    // The words in the mark.
    expect(contrast(WHITE, maroon)).toBeGreaterThanOrEqual(AA_TEXT);
    for (const fill of DECORATIVE_CARD_FILLS) {
      const value = t[tokenName(fill)]!;
      // The edge: white against the card, a non-text boundary.
      expect(contrast(WHITE, value), `edge on ${fill}`).toBeGreaterThanOrEqual(AA_NON_TEXT);
      // And the measurement that made the edge necessary: maroon alone does
      // not reach even non-text contrast against any of these fills.
      expect(contrast(maroon, value), `maroon on ${fill}`).toBeLessThan(AA_NON_TEXT);
    }
  });

  it("the mark's stylesheet rule is maroon, white words, white edge, and no color-mix", async () => {
    const css = await readFile(path.join(process.cwd(), "app/globals.css"), "utf8");
    const rule = /\.card--filled \.card-mark\s*\{[\s\S]*?\}/.exec(css);
    expect(rule).not.toBeNull();
    expect(rule![0]).toMatch(/background:\s*var\(--phb-maroon\)/);
    expect(rule![0]).toMatch(/color:\s*#fff/);
    expect(rule![0]).toMatch(/border:\s*1px solid #fff/);
    expect(rule![0]).not.toContain("color-mix");
  });

  it("contains no red and no maroon - the alarm hue and the mark's own colour", () => {
    for (const fill of DECORATIVE_CARD_FILLS) {
      expect(fill).not.toMatch(/red|maroon/);
    }
  });

  it("uses only ink-tier values or purple, never a bright that white fails on", async () => {
    const t = await tokens();
    for (const fill of DECORATIVE_CARD_FILLS) {
      const name = tokenName(fill);
      const isInk = name.endsWith("-ink");
      expect(isInk || name === "--phb-purple", fill).toBe(true);
      // Which is the same fact measured: the bright sibling of every ink fails.
      if (isInk) {
        const bright = t[name.replace(/-ink$/, "")];
        expect(bright).toBeDefined();
        expect(contrast(WHITE, bright!)).toBeLessThan(AA_TEXT);
      }
    }
  });

  it("wraps past the end rather than running out", () => {
    const n = DECORATIVE_CARD_FILLS.length;
    expect(decorativeCardFill(0)).toBe(DECORATIVE_CARD_FILLS[0]);
    expect(decorativeCardFill(n)).toBe(DECORATIVE_CARD_FILLS[0]);
    expect(decorativeCardFill(n + 1)).toBe(DECORATIVE_CARD_FILLS[1]);
    expect(decorativeCardFill(-1)).toBe(DECORATIVE_CARD_FILLS[n - 1]);
  });
});

// =============================================================================
// 1 & 3. Stable, by creation order, and unrelated to health
// =============================================================================

describe("a project's colour", () => {
  it("is the same on every render", () => {
    const data = payload([project({ projectId: "3" }), project({ projectId: "8", name: "Kenwood Mall" })]);
    const first = renderedFills(render(data));
    const second = renderedFills(render(data));
    expect(first.size).toBe(2);
    expect(second).toEqual(first);
  });

  it("does not change with its health", () => {
    const calm = project({ projectId: "3" });
    const alarmed = project({
      projectId: "3",
      health: { activePoints: 26, pointsAtRisk: 9, riskCounts: risks({ ok: 17, data_lost: 9 }), minutesSinceNewestReading: 4 },
    });
    const empty = project({ projectId: "3", buildings: 0, stations: 0, health: null });

    const fillOf = (p: DashboardProject) => renderedFills(render(payload([p]))).get(p.name);
    expect(fillOf(calm)).toBeDefined();
    expect(fillOf(alarmed)).toBe(fillOf(calm));
    expect(fillOf(empty)).toBe(fillOf(calm));

    // And the at-risk card still carries the mark, on the coloured card.
    const html = render(payload([alarmed]));
    expect(html).toContain('class="card-mark"');
    expect(html).toContain("9 points at risk");
    expect(html).toContain("card--filled");
  });

  it("is computed from ids and nothing else", async () => {
    // The mutation this guards against: `decorativeCardFill(pointsAtRisk)`,
    // or any read of health, name or counts. The fill function is handed
    // only ids, so a change to its signature shows up here too.
    const source = await readFile(
      path.join(process.cwd(), "app/(modules)/bas/project-colours.ts"),
      "utf8",
    ).then((s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*/g, ""));
    expect(source).not.toMatch(/health|pointsAtRisk|riskCounts|buildings|stations|\.name/);
    expect(source).toContain("projectId");
  });

  it("follows creation order, not display order, so an early-sorting newcomer recolours nobody", () => {
    // Display order is org-then-name. "Aardvark Plaza" sorts first and was
    // created last; it takes the LAST colour, and the two before it keep theirs.
    const before = [project({ projectId: "3", name: "Liberty Center" }), project({ projectId: "8", name: "Kenwood Mall" })];
    const after = [project({ projectId: "12", name: "Aardvark Plaza" }), ...before];

    const was = projectFills(before);
    const now = projectFills(after);
    expect(was.get("3")).toBe(DECORATIVE_CARD_FILLS[0]);
    expect(was.get("8")).toBe(DECORATIVE_CARD_FILLS[1]);
    expect(now.get("3")).toBe(was.get("3"));
    expect(now.get("8")).toBe(was.get("8"));
    expect(now.get("12")).toBe(DECORATIVE_CARD_FILLS[2]);

    // The same, as rendered - the component uses the same function.
    const rendered = renderedFills(render(payload(after)));
    expect(rendered.get("Liberty Center")).toBe(DECORATIVE_CARD_FILLS[0]);
    expect(rendered.get("Kenwood Mall")).toBe(DECORATIVE_CARD_FILLS[1]);
    expect(rendered.get("Aardvark Plaza")).toBe(DECORATIVE_CARD_FILLS[2]);
  });

  it("orders ids numerically, not as strings", () => {
    // "10" sorts before "9" as text. As ids, 9 was created first.
    const fills = projectFills([{ projectId: "10" }, { projectId: "9" }]);
    expect(fills.get("9")).toBe(DECORATIVE_CARD_FILLS[0]);
    expect(fills.get("10")).toBe(DECORATIVE_CARD_FILLS[1]);
  });

  it("gives the first project the first brand colour, and the seventh the first again", () => {
    const seven = Array.from({ length: 7 }, (_, i) => ({ projectId: String(i + 1) }));
    const fills = projectFills(seven);
    expect(fills.get("1")).toBe(DECORATIVE_CARD_FILLS[0]);
    expect(fills.get("6")).toBe(DECORATIVE_CARD_FILLS[5]);
    expect(fills.get("7")).toBe(DECORATIVE_CARD_FILLS[0]);
    // Six distinct among the first six.
    expect(new Set(seven.slice(0, 6).map((p) => fills.get(p.projectId))).size).toBe(6);
  });
});

// =============================================================================
// Against the database: a new row takes the next colour
// =============================================================================

describe("adding a project row", () => {
  const PREFIX = "ZZCOLOUR_";
  let viewer: Viewer;
  let orgId: bigint;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.spyOn(console, "log").mockImplementation(() => {});
    resetBasAvailabilityCache();
    await testDb.basProject.deleteMany({ where: { name: { startsWith: PREFIX } } });
    await testDb.basOrg.deleteMany({ where: { name: { startsWith: PREFIX } } });
    await resetDb();
    await seedChangeOrdersModule();
    await seedBasModule();
    const org = await testDb.basOrg.create({ data: { name: `${PREFIX}ORG` } });
    orgId = org.orgId;
    await testDb.basProject.create({ data: { orgId, name: `${PREFIX}Liberty Center` } });
    await testDb.basProject.create({ data: { orgId, name: `${PREFIX}Kenwood Mall` } });

    const employee = await createEmployee({ entraOid: "oid-colour" });
    await grantModule(employee.id, BAS_MODULE_KEY);
    signedInAs("oid-colour");
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
    await testDb.basProject.deleteMany({ where: { name: { startsWith: PREFIX } } });
    await testDb.basOrg.deleteMany({ where: { name: { startsWith: PREFIX } } });
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await disconnectDb();
  });

  it("assigns the next colour and leaves the existing assignments alone", async () => {
    const before = await getDashboard(viewer);
    const was = projectFills(before.projects);
    const byName = (d: BasDashboard, n: string) =>
      d.projects.find((p) => p.name === `${PREFIX}${n}`)!.projectId;
    expect(was.get(byName(before, "Liberty Center"))).toBe(DECORATIVE_CARD_FILLS[0]);
    expect(was.get(byName(before, "Kenwood Mall"))).toBe(DECORATIVE_CARD_FILLS[1]);

    // Sorts first by name; created last.
    await testDb.basProject.create({ data: { orgId, name: `${PREFIX}Aardvark Plaza` } });

    const after = await getDashboard(viewer);
    expect(after.projects[0]?.name).toBe(`${PREFIX}Aardvark Plaza`);
    const now = projectFills(after.projects);
    expect(now.get(byName(after, "Liberty Center"))).toBe(was.get(byName(before, "Liberty Center")));
    expect(now.get(byName(after, "Kenwood Mall"))).toBe(was.get(byName(before, "Kenwood Mall")));
    expect(now.get(byName(after, "Aardvark Plaza"))).toBe(DECORATIVE_CARD_FILLS[2]);
  });
});
