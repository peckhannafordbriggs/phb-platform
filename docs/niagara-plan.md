# Tridium Niagara module: plan

Status: approved in outline 2026-10-30. Open decisions are listed at the end and
marked OPEN where they affect a step.

Background and assessment rules: the project context doc (`CLAUDE_CONTEXT.md` in
the phb-platform-ws Claude project). This file is the build plan only.

---

## What it is

A new module, `niagara` ("Tridium Niagara"), separate from BAS. Engineers create
projects, upload sequences of operations (SOO) and wire sheet PDFs, and run
**Analyze**: a review that compares each SOO requirement with the wire sheet
evidence and returns cited findings plus a Pass / Fail / Incomplete result.

Module home is a list of every project ever created, newest first, visible to
every user who can open the module (flat grant, same as Freeze Protection).

## Findings that shaped the design

| Finding | Consequence |
|---|---|
| Workbench wire sheet PDFs are vector exports. `EF2Logic.pdf` yields every block name and type plus a link table (L1..L5, full source and target slot paths) | The wire sheet is parsed by code. The model never has to read a diagram to know what is linked to what |
| M5.00 is one 3024 x 2160 pt sheet. Text extracts in a mostly readable order, with diagram labels mixed in | SOO text is extracted by code; the model picks out requirements and must quote them. Code checks every quote is present in the extracted text |
| Freeze Protection already has projects, a flat grant, and uses `audit_events` as its history | Copy that shape. No separate decisions or history table |
| The platform has no background job system | Analyze runs as a few short, persisted steps the page drives (extract, then compare in batches). No worker, no new infrastructure |
| Each module has its own Anthropic key (`tests/anthropic-key-per-module.test.ts`) | `NIAGARA_ANTHROPIC_API_KEY`, read lazily in `lib/env.ts`. OPEN, see decisions |

## Pipeline

```
Upload SOO + wire sheet PDFs (stored in Postgres)
  -> Parse wire sheet (code): blocks, types, links, folder path, export date
  -> Extract SOO text (code)
  -> Engineer picks scope: equipment, SOO document, wire sheet(s)
  -> Extract requirements for that equipment (model, schema-validated, quotes checked)
  -> Compare each requirement with parsed evidence (model, must cite block / link IDs)
  -> Validate citations, compute overall result (code)
  -> Engineer review: accept / reject / amend, each one an audit row
```

## Rules enforced in code, not in the prompt

1. A cited block or link that is not in the parsed wire sheet is rejected.
2. A requirement quote that is not in the SOO text is rejected.
3. `potential_mismatch` needs at least one cited block or link that contradicts
   the requirement. "Not on this sheet" can only be `insufficient_evidence`.
4. Overall result: any `potential_mismatch` -> Fail; otherwise any
   `insufficient_evidence` or `conflicting` -> Incomplete; otherwise Pass.
5. Proposed tests are always labelled "Proposed, not executed".
6. Engineer decisions never overwrite the automated result. Both are shown.

## Schema (prefix `nia_`)

| Table | Holds |
|---|---|
| `nia_projects` | name, job number (optional), created by, created at |
| `nia_documents` | project, kind (`soo`, `wire_sheet`, `screenshot`), file name, mime, `bytea` content, size, sha256 (unique per project), revision label, parse status, parsed JSONB, uploaded by |
| `nia_analyses` | project, equipment label, document ids, status (`extracting`, `comparing`, `done`, `failed`), overall result, model, prompt version, token usage, error, created by, times |
| `nia_findings` | analysis, ordinal, category, requirement text, SOO quote and location, result, severity, reasoning, cited wire refs JSONB, evidence needed, recommended action, proposed tests JSONB, current engineer decision, amended result, comment |

History of a project, document or finding is `audit_events` filtered by
`metadata.projectId`, as Freeze Protection does.

Upload limits: PDF and PNG only, 25 MB per file (OPEN to adjust).

## Steps

| # | Step | Model |
|---|---|---|
| 1 | Register module: constants, page, seed row, migration, accent entry (`docs/10-adding-a-module.md`) | No |
| 2 | Schema migration for the four tables, with CHECK constraints on every status and result | No |
| 3 | Projects: API + home list (all projects, newest first, creator, last result) + create form | No |
| 4 | Upload: route, type and size checks, sha256 dedupe, revision label, document list in the project | No |
| 5 | Wire sheet parser: blocks, links, folder, export date. Tests on all 7 Seton PDFs. Image-only sheets flagged as unparsed | No |
| 6 | SOO text extraction with page and position, stored on the document | No |
| 7 | Requirement extraction for one equipment scope | Yes |
| 8 | Comparison, in batches, with citation validation and overall result | Yes |
| 9 | Project view: documents, Analyze, results, finding detail, engineer review. Layout OPEN | No |
| 10 | Pilot on EF-1 and EF-2: Engineer's expected findings plus seeded errors (remove a link, change a setpoint, drop an alarm). Measure missed defects, false positives, citation accuracy | Yes |
| 11 | Runbook entries for each new failure mode | No |

Reference material for the pilot: a small static kitControl reference for the
block types in EF-1 and EF-2 (Tstat, And, Not, Multiply, GreaterThan,
NumericWritable, BooleanWritable, DiscreteTotalizerExt). No retrieval system yet.

## Not in this version

Revision comparison, a searchable Niagara reference library, `.bog` import,
station snapshot connector, logic generation, applying changes in Niagara.

## Open decisions

1. Project view layout (step 9).
2. Who can see projects: everyone with a module grant (recommended, platform
   rule), or every signed-in employee with no grant.
3. Accent colour: all five logo colours are taken; a sixth module wears chrome
   purple until a design decision is made.
4. Anthropic key: a new `NIAGARA_ANTHROPIC_API_KEY` (per-module convention) or
   share BAS's.
