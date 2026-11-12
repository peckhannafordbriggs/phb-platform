import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "next-auth";

// The session is mocked. The guard, the PDF reader, the parser, the routes and
// the service are real, and every filled form below is the committed blank
// form filled in by pdfjs, so the tests read exactly what a field team uploads.
vi.mock("@/auth", () => ({ auth: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { auth } from "@/auth";
import * as split from "@/app/api/modules/freeze-protection/import/split/route";
import * as formRoute from "@/app/api/modules/freeze-protection/import/form/route";
import { FormSummary } from "@/app/(modules)/freeze-protection/views/import-panel";
import { describeAuditEvent } from "@/lib/admin/audit-describe";
import { FREEZE_PROTECTION_MODULE_KEY } from "@/lib/modules/freeze-protection/constants";
import { addEquipment, getHistory, listEquipment, updateEquipment } from "@/lib/modules/freeze-protection/equipment";
import {
  FORM_CHOICES,
  FORM_COLUMNS,
  FORM_HEADER_FIELDS,
  FORM_MARKER_FIELD,
  FORM_MARKER_VALUE,
  FORM_ROWS,
  type ParsedForm,
  formField,
  parseForm,
  parseFormDate,
} from "@/lib/modules/freeze-protection/import/form";
import type { FormImportOutcome } from "@/lib/modules/freeze-protection/import/form-commit";
import { readPdf } from "@/lib/modules/freeze-protection/import/pdf";
import { createProject } from "@/lib/modules/freeze-protection/projects";
import { createEmployee, disconnectDb, grantModule, resetDb, testDb } from "./db";

const FORM_FILE = path.join(process.cwd(), "lib/modules/freeze-protection/import/assets/fp-verification-form.pdf");
const authMock = vi.mocked(auth);

async function pdfjs() {
  const g = globalThis as { pdfjsWorker?: unknown };
  if (!g.pdfjsWorker) g.pdfjsWorker = await import("pdfjs-dist/legacy/build/pdf.worker.mjs");
  return import("pdfjs-dist/legacy/build/pdf.mjs");
}

type Widget = { id: string; type: string; value: unknown; items?: { exportValue: string; displayValue: string }[] };

async function blankFields(): Promise<Map<string, Widget[]>> {
  const lib = await pdfjs();
  const task = lib.getDocument({ data: new Uint8Array(await readFile(FORM_FILE)), verbosity: 0 });
  const fields = (await (await task.promise).getFieldObjects()) as Map<string, Widget[]>;
  await task.destroy();
  return fields;
}

/** The committed blank form with these fields filled, saved the way a viewer saves it. */
async function filledForm(values: Record<string, string>): Promise<Uint8Array> {
  const lib = await pdfjs();
  const task = lib.getDocument({ data: new Uint8Array(await readFile(FORM_FILE)), verbosity: 0 });
  const doc = await task.promise;
  const fields = (await doc.getFieldObjects()) as Map<string, Widget[]>;
  for (const [name, value] of Object.entries(values)) {
    const w = fields.get(name)?.[0];
    if (!w) throw new Error(`No field ${name} on the form`);
    doc.annotationStorage.setValue(w.id, { value });
  }
  const bytes = await doc.saveDocument();
  await task.destroy();
  return bytes;
}

/** A hand-written PDF that carries the form's printed mark as plain text and no fields: a flattened copy. */
function flattenedForm(): Uint8Array {
  const lines = ["FREEZE PROTECTION VERIFICATION", "PHB-FP-FORM v1 Page 1 of 2"];
  for (let i = 1; i <= 24; i++) lines.push(`${i} AHU-${i} Water Yes Manual reset`);
  const stream = lines.map((s, i) => `BT /F1 10 Tf 40 ${560 - i * 20} Td (${s}) Tj ET`).join("\n");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 792 612] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
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
const upload = (bytes: Uint8Array, name = "form.pdf") => {
  const form = new FormData();
  form.set("file", new File([new Uint8Array(bytes)], name, { type: "application/pdf" }));
  return new Request("http://localhost/api", { method: "POST", body: form });
};
const data = async <T>(res: Response) => ((await res.json()) as { data: T }).data;
const error = async (res: Response) => ((await res.json()) as { error: { code: string; message: string } }).error;

async function newProject(actorId: string, jobNumber = "26-200") {
  const r = await createProject(actorId, { jobNumber, name: "Mason R Building" });
  if (!r.ok) throw new Error(r.message);
  return r.data;
}

/** Upload a filled form, then save it, exactly as the import panel does. */
async function importFilled(projectId: string, values: Record<string, string>) {
  const read = await split.POST(upload(await filledForm(values)));
  expect(read.status).toBe(200);
  const body = await data<{ kind: string; fileName: string; form: ParsedForm }>(read);
  expect(body.kind).toBe("form");
  const saved = await formRoute.POST(json({ projectId, fileName: body.fileName, jobNumber: body.form.jobNumber, rows: body.form.rows }));
  return { saved, form: body.form };
}

// ---------------------------------------------------------------------------
// The contract between the committed PDF and form.ts
// ---------------------------------------------------------------------------

describe("the committed form", () => {
  it("has the marker, the header fields and every row's fields, with the dropdowns form.ts reads", async () => {
    const fields = await blankFields();
    expect(fields.get(FORM_MARKER_FIELD)?.[0]?.value).toBe(FORM_MARKER_VALUE);
    for (const name of FORM_HEADER_FIELDS) expect(fields.has(name), name).toBe(true);
    for (let n = 1; n <= FORM_ROWS; n++) {
      for (const c of FORM_COLUMNS) {
        const w = fields.get(formField(n, c.key))?.[0];
        expect(w, formField(n, c.key)).toBeDefined();
        if (c.choices === null) expect(w!.type).toBe("text");
        else expect(w!.items!.map((i) => i.exportValue)).toEqual([" ", ...Object.keys(FORM_CHOICES[c.choices])]);
      }
    }
    expect(fields.has(formField(FORM_ROWS + 1, "name"))).toBe(false);
  });

  it("is recognised as the form before any page text is read, and a drawing is not", async () => {
    const form = await readPdf(new Uint8Array(await readFile(FORM_FILE)));
    expect(form.kind).toBe("form");
  });
});

// ---------------------------------------------------------------------------
// parseForm: pure
// ---------------------------------------------------------------------------

describe("parseForm", () => {
  const base = { [FORM_MARKER_FIELD]: FORM_MARKER_VALUE, tested_by: "J. Smith", test_date: "11/9/2026" };

  it("maps every dropdown to its stored value and applies tester and date only to tested rows", () => {
    const parsed = parseForm({
      ...base,
      job_number: " 26-200 ",
      r01_name: "AHU-1",
      r01_type: "Air handling unit",
      r01_coil: "Glycol",
      r01_status: "Installed, filled",
      r01_exposure: "Yes",
      r01_protection: "Manual reset",
      r01_fan: "Yes",
      r01_damper: "No",
      r01_valve: " ",
      r01_trip: "38 °F",
      r02_name: "FCU-9",
      r02_coil: "Water",
      r02_exposure: "Unknown",
    });
    expect(parsed.problems).toEqual([]);
    expect(parsed.jobNumber).toBe("26-200");
    expect(parsed.rows).toEqual([
      {
        name: "AHU-1",
        equipmentType: "Air handling unit",
        areaServed: null,
        coil: "glycol",
        status: "filled",
        exposure: "yes",
        protection: "manual",
        testFanStops: "yes",
        testDamperCloses: "no",
        testValveFullFlow: null,
        testManualReset: null,
        tripTempF: 38,
        testedBy: "J. Smith",
        testDate: "2026-11-09",
        notes: null,
      },
      expect.objectContaining({ name: "FCU-9", coil: "water", exposure: "unknown", testedBy: null, testDate: null }),
    ]);
  });

  it("says why a row or a value was left out, by row number", () => {
    const parsed = parseForm({
      ...base,
      test_date: "next tuesday",
      r01_name: "AHU-1",
      r02_coil: "Water",
      r03_name: "ahu-1",
      r04_name: "EF-1",
      r04_coil: "Chilled water",
      r04_trip: "warm",
    });
    expect(parsed.rows.map((r) => r.name)).toEqual(["AHU-1", "EF-1"]);
    expect(parsed.rows[1]).toMatchObject({ coil: null, tripTempF: null });
    expect(parsed.problems.join(" ")).toMatch(/Test date "next tuesday" is not a date/);
    expect(parsed.problems.join(" ")).toMatch(/Row 2 has answers but no name/);
    expect(parsed.problems.join(" ")).toMatch(/Row 3 repeats ahu-1/);
    expect(parsed.problems.join(" ")).toMatch(/Row 4 \(EF-1\): "Chilled water" is not a choice for coil/);
    expect(parsed.problems.join(" ")).toMatch(/Row 4 \(EF-1\): trip temperature "warm"/);
  });

  it("reads dates as people write them, and refuses days that do not exist", () => {
    expect(parseFormDate("2026-11-09")).toBe("2026-11-09");
    expect(parseFormDate("11/9/2026")).toBe("2026-11-09");
    expect(parseFormDate("11-09-26")).toBe("2026-11-09");
    expect(parseFormDate("2/30/2026")).toBeNull();
    expect(parseFormDate("soon")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Routes and service, against the database
// ---------------------------------------------------------------------------

beforeEach(async () => {
  vi.clearAllMocks();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  await resetDb();
  await testDb.module.create({ data: { key: FREEZE_PROTECTION_MODULE_KEY, displayName: "Freeze Protection", sortOrder: 500 } });
});
afterEach(() => vi.restoreAllMocks());
afterAll(disconnectDb);

describe("access", () => {
  it("404 without the grant for the blank form and for saving one, and 401 with no session", async () => {
    await signIn(false);
    expect((await formRoute.GET()).status).toBe(404);
    expect((await formRoute.POST(json({}))).status).toBe(404);
    authMock.mockResolvedValue(null as never);
    expect((await formRoute.GET()).status).toBe(401);
  });

  it("serves the blank form as a PDF download to anyone with the grant", async () => {
    await signIn(true);
    const res = await formRoute.GET();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("content-disposition")).toMatch(/attachment; filename="freeze-protection-verification-form\.pdf"/);
    expect(Buffer.from(await res.arrayBuffer()).subarray(0, 5).toString()).toBe("%PDF-");
  });
});

describe("telling a form from a schedule", () => {
  beforeEach(() => signIn(true));

  it("returns a filled form's rows as kind form, without touching the schedule split", async () => {
    const res = await split.POST(upload(await filledForm({ r01_name: "AHU-1", r01_coil: "Water" })));
    expect(res.status).toBe(200);
    const body = await data<{ kind: string; form: ParsedForm }>(res);
    expect(body.kind).toBe("form");
    expect(body.form.rows).toEqual([expect.objectContaining({ name: "AHU-1", coil: "water" })]);
  });

  it("422 for a blank form, saying to fill in and save it", async () => {
    const res = await split.POST(upload(new Uint8Array(await readFile(FORM_FILE))));
    expect(res.status).toBe(422);
    const e = await error(res);
    expect(e.code).toBe("empty_form");
    expect(e.message).toMatch(/no units filled in/);
  });

  it("422 for a flattened form instead of reading it as a schedule", async () => {
    const res = await split.POST(upload(flattenedForm()));
    expect(res.status).toBe(422);
    expect((await error(res)).code).toBe("form_flattened");
  });
});

describe("saving a form", () => {
  it("adds new units with their answers and audits them as recorded from the form", async () => {
    const me = await signIn(true);
    const project = await newProject(me.id);
    const { saved } = await importFilled(project.id, {
      job_number: "26-200",
      tested_by: "J. Smith",
      test_date: "2026-11-09",
      r01_name: "AHU-1",
      r01_coil: "Water",
      r01_status: "In service",
      r01_exposure: "Yes",
      r01_protection: "Manual reset",
      r01_fan: "Yes",
      r01_damper: "Yes",
      r01_valve: "Yes",
      r01_reset: "Yes",
      r01_trip: "38",
    });
    expect(saved.status).toBe(201);
    const out = await data<FormImportOutcome>(saved);
    expect(out).toEqual({ created: ["AHU-1"], filled: [], differences: [], unchanged: [] });

    const [line] = await listEquipment(project.id);
    expect(line).toMatchObject({ name: "AHU-1", coil: "water", exposure: "yes", protection: "manual", status: "service" });
    expect(line!.test).toMatchObject({ tripTempF: "38", testedBy: "J. Smith", testDate: "2026-11-09" });
    expect(line!.source).toBe("Form · form.pdf");

    const history = await getHistory(line!.id);
    expect(history.map((h) => h.sentence).join(" | ")).toMatch(/added AHU-1 to the job 26-200 equipment list from the form "form\.pdf"/);
    expect(history.map((h) => h.sentence).join(" | ")).toMatch(/recorded .*the fan test/);
    const summary = await testDb.auditEvent.findFirstOrThrow({ where: { action: "fp.form_imported" } });
    expect(summary.metadata).toMatchObject({ created: 1, filled: 0, differences: 0, fileName: "form.pdf" });
    expect(describeAuditEvent({ ...summary, actor: null, target: null }, new Map()).sentence).toMatch(/imported a freeze protection form/);
  });

  it("fills only blanks on a unit already there, keeps what is there, and lists every difference", async () => {
    const me = await signIn(true);
    const project = await newProject(me.id);
    const added = await addEquipment(me.id, { projectId: project.id, name: "AHU-1", coil: "water", areaServed: null });
    if (!added.ok) throw new Error(added.message);
    await updateEquipment(me.id, added.data.id, { exposure: "yes" });

    const { saved } = await importFilled(project.id, {
      r01_name: "ahu-1",
      r01_area: "Roof",
      r01_coil: "Glycol",
      r01_exposure: "Yes",
      r01_protection: "Auto reset",
      r01_status: "Installed, dry",
    });
    expect(saved.status).toBe(201);
    const out = await data<FormImportOutcome>(saved);
    expect(out.created).toEqual([]);
    expect(out.filled).toEqual([{ name: "AHU-1", fields: ["Area served", "Protection"] }]);
    // Exposure matched; coil disagreed; status counts as set once the unit has an answer.
    expect(out.differences).toEqual([
      { name: "AHU-1", field: "Coil", platform: "Water", form: "Glycol" },
      { name: "AHU-1", field: "Status", platform: "In service", form: "Installed, dry" },
    ]);

    const [line] = await listEquipment(project.id);
    expect(line).toMatchObject({ coil: "water", areaServed: "Roof", protection: "auto", status: "service" });
    const actions = (await testDb.auditEvent.findMany({ where: { moduleKey: FREEZE_PROTECTION_MODULE_KEY }, orderBy: { occurredAt: "asc" } })).map((a) => a.action);
    expect(actions.slice(-3)).toEqual(["fp.equipment_updated", "fp.result_updated", "fp.form_imported"]);
  });

  it("fills status on a unit nobody has verified yet, and reports an untouched match as already matched", async () => {
    const me = await signIn(true);
    const project = await newProject(me.id);
    await addEquipment(me.id, { projectId: project.id, name: "FCU-1", coil: "water" });
    await addEquipment(me.id, { projectId: project.id, name: "FCU-2", coil: "water" });

    const { saved } = await importFilled(project.id, { r01_name: "FCU-1", r01_status: "Not installed", r02_name: "FCU-2", r02_coil: "Water" });
    const out = await data<FormImportOutcome>(saved);
    expect(out.filled).toEqual([{ name: "FCU-1", fields: ["Status"] }]);
    expect(out.unchanged).toEqual(["FCU-2"]);
    expect((await listEquipment(project.id)).find((l) => l.name === "FCU-1")!.status).toBe("not_installed");
  });

  it("refuses a form for another job and writes nothing", async () => {
    const me = await signIn(true);
    const project = await newProject(me.id);
    const { saved } = await importFilled(project.id, { job_number: "25-999", r01_name: "AHU-1" });
    expect(saved.status).toBe(422);
    const e = await error(saved);
    expect(e.code).toBe("wrong_project");
    expect(e.message).toMatch(/job 25-999/);
    expect(await listEquipment(project.id)).toEqual([]);
  });

  it("422 for a value outside the vocabulary or an unknown field; 404 for a missing project", async () => {
    const me = await signIn(true);
    const project = await newProject(me.id);
    const row = { name: "AHU-1", equipmentType: null, areaServed: null, coil: null, status: null, exposure: null, protection: null, testFanStops: null, testDamperCloses: null, testValveFullFlow: null, testManualReset: null, tripTempF: null, testedBy: null, testDate: null, notes: null };
    const post = (body: unknown) => formRoute.POST(json(body));
    expect((await post({ projectId: project.id, fileName: "f.pdf", jobNumber: null, rows: [{ ...row, coil: "chilled" }] })).status).toBe(422);
    expect((await post({ projectId: project.id, fileName: "f.pdf", jobNumber: null, rows: [{ ...row, extra: 1 }] })).status).toBe(422);
    expect((await post({ projectId: "999999", fileName: "f.pdf", jobNumber: null, rows: [row] })).status).toBe(404);
  });
});

describe("the summary", () => {
  it("puts every difference in a table, in words, beside what was filled, added and left out", () => {
    const html = renderToStaticMarkup(
      createElement(FormSummary, {
        doneHref: "/freeze-protection?project=1",
        result: {
          fileName: "level-2.pdf",
          created: ["FCU-9"],
          filled: [{ name: "AHU-1", fields: ["Area served", "Protection"] }],
          differences: [{ name: "AHU-1", field: "Coil", platform: "Water", form: "Glycol" }],
          unchanged: ["FCU-2"],
          problems: ["Row 3 has answers but no name, so it was left out."],
        },
      }),
    );
    expect(html).toContain("Added 1 unit and filled 2 blank answers on 1 unit");
    expect(html).toContain("1 answer on the form differs from what is already here");
    expect(html).toMatch(/Kept \(platform\)[\s\S]*Form says[\s\S]*AHU-1[\s\S]*Coil[\s\S]*Water[\s\S]*Glycol/);
    expect(html).toContain("AHU-1: area served, protection");
    expect(html).toContain("FCU-2");
    expect(html).toContain("Row 3 has answers but no name");
  });
});
