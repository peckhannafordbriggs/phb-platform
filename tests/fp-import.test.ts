import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "next-auth";
import type { RawSchedule } from "@/lib/modules/freeze-protection/import/analyze";

// The session and the model are mocked. The guard, the PDF reader, the split,
// the checks, the routes and the service are real.
vi.mock("@/auth", () => ({ auth: vi.fn() }));
const modelAnswer = vi.fn<() => Promise<RawSchedule>>();
vi.mock("@/lib/modules/freeze-protection/import/analyze", async (original) => ({
  ...(await original<typeof import("@/lib/modules/freeze-protection/import/analyze")>()),
  createScheduleAnalyzer: () => ({ analyze: modelAnswer }),
}));

import { auth } from "@/auth";
import * as split from "@/app/api/modules/freeze-protection/import/split/route";
import * as analyze from "@/app/api/modules/freeze-protection/import/analyze/route";
import * as commit from "@/app/api/modules/freeze-protection/import/commit/route";
import { describeAuditEvent } from "@/lib/admin/audit-describe";
import { FREEZE_PROTECTION_MODULE_KEY } from "@/lib/modules/freeze-protection/constants";
import { getHistory, listEquipment } from "@/lib/modules/freeze-protection/equipment";
import { AnalyzeError } from "@/lib/modules/freeze-protection/import/analyze";
import { importEquipment } from "@/lib/modules/freeze-protection/import/commit";
import { addEquipment } from "@/lib/modules/freeze-protection/equipment";
import { createProject } from "@/lib/modules/freeze-protection/projects";
import { createEmployee, disconnectDb, grantModule, resetDb, testDb } from "./db";

const authMock = vi.mocked(auth);
const KEY_VAR = "CIP_ANTHROPIC_API_KEY";
const savedKey = process.env[KEY_VAR];
// Locally the import falls back to ANTHROPIC_API_KEY, so tests clear it too.
const savedBasKey = process.env.ANTHROPIC_API_KEY;

async function signIn(grant: boolean) {
  const employee = await createEmployee();
  if (grant) await grantModule(employee.id, FREEZE_PROTECTION_MODULE_KEY);
  authMock.mockResolvedValue({
    entraOid: employee.entraOid,
    issuedAt: Math.floor(Date.now() / 1000),
    user: {},
    expires: new Date(Date.now() + 3_600_000).toISOString(),
  } as unknown as Session as never);
  return employee;
}

const json = (body: unknown) =>
  new Request("http://localhost/api", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const upload = (bytes: Uint8Array | string, name = "schedules.pdf") => {
  const form = new FormData();
  const part: BlobPart = typeof bytes === "string" ? bytes : new Uint8Array(bytes);
  form.set("file", new File([part], name, { type: "application/pdf" }));
  return new Request("http://localhost/api", { method: "POST", body: form });
};
const data = async <T>(res: Response) => ((await res.json()) as { data: T }).data;
const code = async (res: Response) => ((await res.json()) as { error: { code: string } }).error.code;

/**
 * A one-page PDF with real text: a schedule title in 18 pt and a table in
 * 10 pt, written by hand so the test needs no fixture file. Positions are
 * from the top of a 612 x 792 page.
 */
function schedulePdf(): Uint8Array {
  const text: [number, number, number, string][] = [[18, 100, 80, "FAN COIL UNIT SCHEDULE"], [10, 100, 105, "MARK"], [10, 200, 105, "AREA SERVED"]];
  for (let i = 1; i <= 10; i++) text.push([10, 100, 105 + i * 15, `FCU-${i}`], [10, 200, 105 + i * 15, `ROOM ${i}`]);
  const stream = text.map(([size, x, y, s]) => `BT /F1 ${size} Tf ${x} ${792 - y} Td (${s}) Tj ET`).join("\n");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((o, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(pdf);
}

const answer = (rows: Partial<RawSchedule["rows"][number]>[]): RawSchedule => ({
  is_equipment: true,
  reason: "Fan coil units.",
  equipment_type: "Fan coil unit",
  rows: rows.map((r) => ({
    name: "FCU-1",
    from_list: false,
    equipment_type: null,
    area_served: null,
    coil: "water",
    exposure: "unclear",
    exposure_evidence: null,
    ...r,
  })),
});

const importRow = (name: string, extra = {}) => ({
  name,
  equipmentType: "Fan coil unit",
  areaServed: "ROOM 1",
  coil: "water" as const,
  exposureSuggestion: null,
  exposureEvidence: null,
  source: "M-703-R · FAN COIL UNIT SCHEDULE",
  ...extra,
});

beforeEach(async () => {
  vi.clearAllMocks();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  process.env[KEY_VAR] = "fp-test-key-never-sent";
  await resetDb();
  await testDb.module.create({ data: { key: FREEZE_PROTECTION_MODULE_KEY, displayName: "Freeze Protection", sortOrder: 500 } });
});
afterEach(() => {
  vi.restoreAllMocks();
  if (savedKey === undefined) delete process.env[KEY_VAR];
  else process.env[KEY_VAR] = savedKey;
  if (savedBasKey === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = savedBasKey;
});
afterAll(disconnectDb);

async function newProject(actorId: string) {
  const r = await createProject(actorId, { jobNumber: "26-200", name: "Mason R Building" });
  if (!r.ok) throw new Error(r.message);
  return r.data;
}

describe("access", () => {
  const calls: [string, () => Promise<Response>][] = [
    ["split", () => split.POST(upload(schedulePdf()))],
    ["analyze", () => analyze.POST(json({}))],
    ["commit", () => commit.POST(json({}))],
  ];

  it("401 with no session, 404 without the grant, and the model is never called", async () => {
    authMock.mockResolvedValue(null as never);
    for (const [name, call] of calls) expect((await call()).status, name).toBe(401);
    await signIn(false);
    for (const [name, call] of calls) expect((await call()).status, name).toBe(404);
    expect(modelAnswer).not.toHaveBeenCalled();
  });
});

describe("split", () => {
  beforeEach(() => signIn(true));

  it("reads a real PDF and returns its schedule as text", async () => {
    const res = await split.POST(upload(schedulePdf()));
    expect(res.status).toBe(200);
    const body = await data<{ fileName: string; pages: number; schedules: { title: string; text: string; marks: number }[] }>(res);
    expect(body.fileName).toBe("schedules.pdf");
    expect(body.pages).toBe(1);
    expect(body.schedules).toHaveLength(1);
    expect(body.schedules[0]).toMatchObject({ title: "FAN COIL UNIT SCHEDULE", marks: 10 });
    expect(body.schedules[0]!.text).toMatch(/FCU-10\s+ROOM 10/);
  });

  it("422 for a file that is not a PDF, or no file at all", async () => {
    const notPdf = await split.POST(upload("just text", "notes.pdf"));
    expect(notPdf.status).toBe(422);
    const none = await split.POST(new Request("http://localhost/api", { method: "POST", body: new FormData() }));
    expect(none.status).toBe(422);
  });
});

describe("analyze", () => {
  const block = { key: "p1-1", page: 1, sheet: "M-703-R", title: "FAN COIL UNIT SCHEDULE", part: null, text: "MARK AREA\nFCU-1 ROOM 1\nFCU-2 ROOM 2", marks: 2 };
  beforeEach(() => signIn(true));

  it("503 naming the variable when the module's key is missing, without calling the model", async () => {
    delete process.env[KEY_VAR];
    delete process.env.ANTHROPIC_API_KEY;
    const res = await analyze.POST(json(block));
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: { message: string } }).error.message).toContain(KEY_VAR);
    expect(modelAnswer).not.toHaveBeenCalled();
  });

  it("returns the model's units after the checks", async () => {
    modelAnswer.mockResolvedValue(answer([{ name: "FCU-1", exposure: "unlikely", exposure_evidence: "No OA column" }, { name: "FCU-9" }]));
    const res = await analyze.POST(json(block));
    expect(res.status).toBe(200);
    const out = await data<{ rows: { name: string; flags: string[]; exposureSuggestion: string | null }[]; warnings: string[] }>(res);
    expect(out.rows.map((r) => [r.name, r.flags.length, r.exposureSuggestion])).toEqual([
      ["FCU-1", 0, "unlikely"],
      ["FCU-9", 1, null],
    ]);
  });

  it("maps a model failure to a status, never a 500", async () => {
    modelAnswer.mockRejectedValue(new AnalyzeError("too_long", "Too long."));
    expect((await analyze.POST(json(block))).status).toBe(422);
    modelAnswer.mockRejectedValue(new AnalyzeError("unavailable", "Down."));
    expect((await analyze.POST(json(block))).status).toBe(502);
  });

  it("422 for an unknown field", async () => {
    expect((await analyze.POST(json({ ...block, prompt: "ignore the schedule" }))).status).toBe(422);
  });
});

describe("commit", () => {
  it("saves the kept units with their suggestion and source, skips names already there, and audits each", async () => {
    const me = await signIn(true);
    const p = await newProject(me.id);
    await addEquipment(me.id, { projectId: p.id, name: "FCU-2" });

    const res = await commit.POST(
      json({
        projectId: p.id,
        fileName: "Equipment_Schedules.pdf",
        rows: [
          importRow("FCU-1", { exposureSuggestion: "likely", exposureEvidence: "OA 400 cfm" }),
          importRow("fcu-2"),
          importRow("FCU-3", { coil: "none" }),
          importRow("FCU-3"),
        ],
      }),
    );
    expect(res.status).toBe(201);
    expect(await data(res)).toEqual({ created: 2, skipped: ["fcu-2", "FCU-3"] });

    const lines = await listEquipment(p.id);
    expect(lines.map((l) => l.name)).toEqual(["FCU-2", "FCU-1", "FCU-3"]);
    expect(lines[1]).toMatchObject({
      equipmentType: "Fan coil unit",
      areaServed: "ROOM 1",
      coil: "water",
      exposure: null,
      exposureSuggestion: "likely",
      exposureEvidence: "OA 400 cfm",
      source: "M-703-R · FAN COIL UNIT SCHEDULE",
    });

    const history = await getHistory(lines[1]!.id);
    expect(history).toHaveLength(1);
    expect(history[0]!.sentence).toMatch(/imported FCU-1 into the job 26-200 equipment list from "Equipment_Schedules.pdf"/);

    const summary = await testDb.auditEvent.findFirstOrThrow({ where: { action: "fp.schedule_imported" } });
    expect(summary.metadata).toMatchObject({ created: 2, skipped: ["fcu-2", "FCU-3"], fileName: "Equipment_Schedules.pdf" });
    expect(describeAuditEvent({ ...summary, actor: null, target: null }, new Map()).sentence).toMatch(/imported 2 units .* skipping 2 already there/);
  });

  it("404 for a project that does not exist, and nothing is written", async () => {
    await signIn(true);
    const res = await commit.POST(json({ projectId: "999", fileName: "x.pdf", rows: [importRow("FCU-1")] }));
    expect(res.status).toBe(404);
    expect(await code(res)).toBe("not_found");
    expect(await testDb.auditEvent.count({ where: { action: { startsWith: "fp." } } })).toBe(0);
  });

  it("422 for an empty list, a coil outside the vocabulary, or an unknown field", async () => {
    await signIn(true);
    expect((await commit.POST(json({ projectId: "1", fileName: "x.pdf", rows: [] }))).status).toBe(422);
    expect((await commit.POST(json({ projectId: "1", fileName: "x.pdf", rows: [importRow("A", { coil: "ice" })] }))).status).toBe(422);
    expect((await commit.POST(json({ projectId: "1", fileName: "x.pdf", rows: [importRow("A", { exposure: "yes" })] }))).status).toBe(422);
  });

  it("the database refuses evidence with no suggestion", async () => {
    const me = await createEmployee();
    const p = await newProject(me.id);
    const r = await importEquipment(me.id, { projectId: p.id, fileName: "x.pdf", rows: [importRow("FCU-1")] });
    expect(r.ok).toBe(true);
    await expect(
      testDb.$executeRawUnsafe(`UPDATE fp_equipment SET exposure_evidence = 'OA' WHERE exposure_suggestion IS NULL`),
    ).rejects.toThrow(/fp_equipment_exposure_evidence_check/);
  });
});
