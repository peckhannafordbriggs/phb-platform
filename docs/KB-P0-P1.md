# Knowledge Base - plan, decisions and the index schema

Module 4. Employees ask about past (legacy) projects in plain English and get an
answer grounded in the project documents, with citations that open the original
file in SharePoint. This document records the decisions, the index schema, and
the order of the build.

Built on top of what Cost Intelligence already provides on `main`: the folder
store (local folder or SharePoint through Graph), the folder-sync pattern, the
worker loop and its Container Apps Job, and the worker image's text tools.

| Phase | Scope | State |
|---|---|---|
| 0 | Branch setup: port the decisions, schema and tests below onto current `main` | **Done** |
| 1 | Schema v2: projects, sheet/cell locations, document versions, conversations, question history | **Done** |
| 2 | Source sync: legacy projects and files from SharePoint (or a local copy), new/changed/deleted detection | Not started |
| 3 | Extraction and chunking with page, section and cell locations | Not started |
| 4 | Embeddings | Not started. Needs request KB-2 |
| 5 | Retrieval: hybrid vector + keyword, project ranking, evaluation set | Not started |
| 6 | Answers with Claude: citations, conflicts, versions, missing evidence, follow-ups | Not started |
| 7 | Automatic sync job, admin view of indexing issues and reported answers | Not started |

---

## The seven module decisions (PLATFORM-CONTEXT.md)

**1. Authoritative system and protocol.** The SharePoint library *Knowledge Base -
Documents*, filed to the PH+B project folder template v3 (13 frozen folders,
`[JOB]_[TAG]_[DESC]_[DATE|vNN]` names). Reached through Microsoft Graph with an
application identity of the module's own.

**2. Read-only or read-write.** Read-only against SharePoint, always. The module
writes only its own `kb_*` tables.

**3. What the platform stores.** A **derived index**: text passages, their
embeddings and file metadata. Never the original file. This passes the test in
`docs/05-database-and-sources.md`: SharePoint owns the documents, and every `kb_*`
table can be truncated and rebuilt by re-running the sync with no loss. A citation
links to the file in SharePoint, where the reader's own permissions apply. The table
comments say so in the database itself.

**4. Near-real-time.** No, but **automatic**: the specification requires new and
changed files to become searchable without anyone acting. Phase 7 adds a
scheduled sync on the Cost Intelligence worker pattern (a Container Apps Job).
Until then the sync is a script a person runs. No webhooks.

**5. Who sees it.** One flat grant (`knowledge-base`). Because of that, folders the
template assigns to Joel alone are **not indexed at all** - see *Scope* below.

**6. Schedules.** One, from Phase 7: the sync job (decision 4), built as a
Container Apps Job like `cipWorkerJob` in `infra/main.bicep`, not inside the web
app. Before Phase 7 the same code runs as `npm run kb:sync`.

**7. The existing route.** SharePoint and OneDrive stay exactly as they are. The
platform is an additional way to find a document, never the only one.

---

## Decisions specific to this module

### Embeddings: Azure OpenAI, `text-embedding-3-small`, 1536 dimensions

Anthropic has no embeddings endpoint, so a second provider is unavoidable. Azure
OpenAI was chosen over Voyage because it stays inside the PH+B tenant and
authenticates with the container app's managed identity (role *Cognitive Services
OpenAI User*), so production holds no API key - CLAUDE.md prohibition 7. Locally a
key is allowed and production refuses one (`lib/modules/knowledge-base/env.ts`).

1536 is the model's native width and is baked into the column type,
`vector(1536)`. **Changing model or width is a migration plus a full re-embed**,
never a variable change. Every chunk records the model that embedded it.

Answers in P4 use Claude through the existing `ANTHROPIC_API_KEY`.

### Scope: what is indexed

`lib/modules/knowledge-base/scope.ts` is the single definition. Every file gets a
`kb_documents` row; a skipped file records why.

| Rule | Reason recorded | Why |
|---|---|---|
| Folders `2A` estimate file, `5A` PH+B cost summary, `8` financial performance | `restricted_folder` | One flat grant: indexing them lets every grantee ask about margins and job cost. Lifting this needs a per-folder permission in the module first |
| Folders `1A` mechanical drawings, `1D` Revit exports | `drawings_folder` | Drawing PDFs extract as scattered labels that match every question and answer none. Revisit after P3 measurements |
| `ARCHIVE_` prefix | `archive_prefix` | Template rule: rejected or superseded |
| `DRAFT_` prefix | `draft_prefix` | Template rule: unreviewed |
| `README.txt` | `folder_readme` | Filing guidance, not project knowledge |
| Not `.pdf` `.docx` `.xlsx` `.md` `.txt` | `unsupported_type` | No reader yet. One legacy `.doc` quote in the sample |
| Over 50 MB | `too_large` | Largest sample file is 19 MB |
| No extractable text | `empty_text` | Set by P2 when a PDF has no text layer |

Curator notes such as `+THIS_FOLDER_IS_MESSED_UP.txt` **are** indexed: the
MAGNODE one explains that the CO numbers on the CO sheets disagree with the log,
which is exactly what an answer needs to know.

### Retrieval shape (built in P3, shaped in P1)

Hybrid: vector similarity (cosine, HNSW) plus PostgreSQL full-text search, because
construction text is full of exact identifiers - `RTU-9`, model numbers, job
numbers - that embeddings blur. The keyword side uses the `simple` dictionary so
those survive tokenising.

---

## The schema (Phase 1)

Prisma models in `prisma/schema.prisma`; migration `20261027120000_add_kb_index`.
Two kinds of table, with different owners:

**The index - derived from SharePoint, safe to rebuild.**

| Table | One row per | Notes |
|---|---|---|
| `kb_projects` | project folder under the legacy root | `is_legacy` decides whether it is searchable; set by the sync from the legacy rule (open decision) |
| `kb_documents` | file in a project folder, indexed or not | Identity `(source_kind, source_id)`: the Graph driveItem id, which survives renames. `status` with `skip_reason` / `error` forced to agree by CHECKs. Versions share a `family_key`; `is_latest` marks the one answers prefer |
| `kb_chunks` | passage | Location is exact or absent: page range (PDF), `section` (Word, Markdown), `sheet` + `cell_range` (Excel), each CHECKed so it cannot be half-stated. `embedding vector(1536)` NULL until embedded, so a sync can resume. `content_tsv` kept by trigger |
| `kb_sync_runs` | sync, `manual` or `scheduled` | At most one `running` (partial unique index, the Cost Intelligence rule) |

**The history - the platform's own record, kept centrally in the platform database and indefinitely, and survives a rebuild.**

| Table | One row per | Notes |
|---|---|---|
| `kb_conversations` | thread of a question and its follow-ups, per employee | Listed newest first |
| `kb_questions` | question and its final answer | `answer` (jsonb) is the answer exactly as shown, sources included. Also the projects searched and how they were chosen, the model, the duration. Only final answers are stored; a failed question is not history |
| `kb_question_sources` | numbered citation | Links into `kb_documents` and `kb_chunks` that go NULL on a rebuild, so an admin can ask "which answers cited this file" while the snapshot stays complete |
| `kb_answer_reports` | employee's report that an answer is wrong | Reason (wrong fact, wrong source, missing source, outdated, other), optional citation number and comment. The platform admin resolves or dismisses each with a note; one open report per person per question |

`source_kind = 'local'` exists so Phases 2 and 3 can be built against the OneDrive
copy before the SharePoint grant arrives. Production never holds a `local` row; the
env reader refuses a local source there.

### What Prisma cannot see

The vector column, the HNSW index, the tsvector trigger, the one-running-sync
index and the CHECKs live only in the migration SQL - the same arrangement as the BAS views and CHECKs.

**The trap:** Prisma cannot express an HNSW index, so the next `prisma migrate dev`
anyone runs will put `DROP INDEX "kb_chunks_embedding_hnsw_idx"` in its generated
migration. Delete that line before committing. `tests/kb-schema.test.ts` fails if
any migration drops the index, the trigger or the extension.

### Precondition everywhere the migration runs

pgvector must be installed (local, CI) or allow-listed (Azure) **before**
`migrate deploy`, or the migration fails and blocks every later deploy, not just
this module's.

| Where | What |
|---|---|
| Azure | Server parameter `azure.extensions` includes `VECTOR`. In `infra/main.bicep`, and set by hand on the live server because CI does not deploy Bicep |
| CI | `pgvector/pgvector:pg17` service image (`.github/workflows/ci.yml`) |
| Each developer | pgvector installed into local PostgreSQL. `DEVELOPER-SETUP.md` |

This affects the other developer too: once this merges, `npm run db:test:setup`
fails on any machine without pgvector, and `tests/global-setup.ts` then refuses to
run the suite.

---

## P0: access still to be granted

Written out verbatim in `runbook.md` -> *Knowledge Base: what to ask IT for*. In
order of need:

1. **`azure.extensions` += `VECTOR`** on the production PostgreSQL server. Needed
   before this branch merges, because the deploy runs the migration.
2. **Azure OpenAI** resource with a `text-embedding-3-small` deployment, and the
   container app's managed identity granted *Cognitive Services OpenAI User* on it.
   Needed for P2 against real data; a developer key unblocks local work.
3. **A KB-only Entra app registration** with Graph
   **`Files.SelectedOperations.Selected`** (Application), granted **read** on the
   legacy projects folder only - the same folder-level mechanism Cost Intelligence
   uses, narrower than a whole-site grant - plus a federated credential for the
   platform's managed identity. Needed for the first production sync, not before:
   Phases 2 and 3 can be built against the local copy.
4. **Employee read access** to that folder in SharePoint. The ingestion identity
   does not give anyone access: a citation link only opens for someone SharePoint
   already lets read the file.

Until 2 and 3 land, Phases 1 to 3 can be built and tested against
`KB_LOCAL_SOURCE_DIR` and the test database.

---

## Decisions taken (2026-10-27)

- **Scope:** drawings (1A, 1D) and the restricted financial folders (2A, 5A, 8)
  stay excluded for the first release.
- **Embeddings:** Azure OpenAI `text-embedding-3-small`, 1536 dimensions.
- **History:** central, in the platform database (not per browser), kept
  indefinitely.
- **Report a wrong answer:** in the first release (`kb_answer_reports`), not
  deferred.
- **Scaffold project:** `221457_MAGNODE` is the one complete project to build and
  test the pipeline against.

## Open questions

- **Which projects are legacy, and where they live.** The SharePoint root is
  still to be confirmed. Proposed rule until then: every project folder under the
  configured root is legacy, so choosing the root is choosing the projects.
- **Who can read history.** Central storage is decided; whether employees see
  only their own questions or everyone's is not.
- Does the folder template ever nest a `2A`, `5A` or `8` code under a different
  parent? The rule matches the code wherever it appears on the path.
