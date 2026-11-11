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
| 2 | Source sync: legacy projects and files from SharePoint (or a local copy), new/changed/deleted detection | **Done** |
| 3 | Extraction and chunking with page, section and cell locations | **Done**. No OCR: a scanned PDF is `skipped`, `empty_text` |
| 4 | Embeddings | **Done** (2026-11-10) |
| 5 | Retrieval: hybrid vector + keyword, project ranking, evaluation set | **Built** (2026-11-10): hybrid, copies collapsed, `npm run kb:eval`. Not yet tuned on a real question set |
| 6 | Answers with Claude: citations, conflicts, versions, missing evidence, follow-ups | **Built** (2026-11-11): Haiku re-sort, Sonnet answers, shared history. Rules are a first version |
| 7 | Automatic sync job, admin view of indexing issues and reported answers | Partly: Index now button, worker job (built, `enableKbWorker` off), clear index. No schedule, no issue or report views |

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
| Folders `1A` mechanical drawings, `1D` Revit exports, and `_Drawings_` files elsewhere under folder `1` (the 1E bulletin sets) | `drawings` | Drawing PDFs extract as scattered labels that match every question and answer none. Only under folder 1: an RFI or submittal with Drawings in its name (12, 11) is text worth reading. Revisit after P3 measurements |
| `DRAFT_` prefix | `draft_prefix` | Template rule: unreviewed |
| `README.txt` | `folder_readme` | Filing guidance, not project knowledge |
| A file directly in the project folder | `project_root_file` | Curation artefacts such as `224070_GAP_LOG.md`, not project documents |
| Not `.pdf` `.docx` `.xlsx` `.xlsm` `.md` `.txt` | `unsupported_type` | No reader yet. `.msg` and legacy `.doc` in the samples |
| Over 250 MB | `too_large` | Largest curated file is 82 MB; specs and contracts pass 1,000 pages |
| No extractable text | `empty_text` | Set by P2 when a PDF has no text layer |

`ARCHIVE_` files are **indexed**, tagged `is_archived`. They are superseded or
rejected versions: an answer never leads with one, but can use it to explain
what changed. A CHECK forbids an archived file being `is_latest`.

**Versions** (`lib/modules/knowledge-base/naming.ts`). The family is the file
name without `ARCHIVE_`, the status word and the `_YYYYMMDD` / `_vNN` suffix, so
`ARCHIVE_224070_SUB_Air_Valves_Rejected_20240119.pdf` and
`224070_SUB_Air_Valves_Approved_20241121.pdf` are one family. The latest is the
newest non-archived member by date or version; on a tie, Executed or Approved
beats Pending or Unexecuted beats Rejected (subcontracts file both copies under
one date). A family whose every member is archived has no latest.

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

Prisma models in `prisma/schema.prisma`; migrations `20261027120000_add_kb_index`
and `20261028120000_kb_archived_versions` (archived files indexed, skip reasons
revised).
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
  indefinitely, and **shared: every KB user sees everyone's questions and
  answers** (2026-10-28), each with who asked it. One person's answer is
  another's search result; the grant is already flat, so this exposes no
  document a grantee could not retrieve themselves.
- **Report a wrong answer:** in the first release (`kb_answer_reports`), not
  deferred.
- **Scaffold project:** `224070_UC_OLD_CHEM` (curated) is the project to build
  and test the pipeline against.
- **Source (2026-10-28):** the Documents library of the Knowledge Base
  SharePoint site; every project folder in it is legacy. Developed against the
  OneDrive copy (`KB_LOCAL_SOURCE_DIR`).
- **Shared SharePoint reader (2026-10-28):** CIP's FolderStore moved to
  `lib/sharepoint/folder-store.ts` for CIP and the KB; the KB takes
  `readOnly(...)`, which has no `write`. Change Orders keeps its own Graph code.
- **Archived versions (2026-10-28):** `ARCHIVE_` files are indexed and tagged,
  not skipped. Drawing sets in 1E (`_Drawings_`) are skipped with 1A and 1D.

## Phase 2: sync and indexing (2026-10-29)

One pipeline: `syncKnowledgeBase` lists the library, reconciles `kb_projects` and
`kb_documents`, then reads every `pending` file into passages. `runbook.md` ->
*Running a Knowledge Base sync* has the operator's view; this is why it is shaped
so.

| Type | Reader | A passage's location |
|---|---|---|
| PDF | pdfjs-dist 4.10 (pure JS, no native install on Windows or in the container; 5.x and later need Node 22.13) | Page range. Lines repeated on 60% of pages (spec project blocks, letterheads) are kept once |
| DOCX | mammoth | Heading path, e.g. `Part 2 - Products > 2.3 Fans`; table cells joined with ` | ` |
| XLSX, XLSM | exceljs (VML drawings stripped first with jszip) | Sheet and cell range, `A30:R34`. A header row names columns; zero-valued formula rows are dropped |
| MD, TXT | built in | Markdown heading path; a text file is one section |

- **Passage size**: aims at 1,800 characters, never over 2,400, never across a
  section or sheet; PDF passages may span pages and say so. At most 4,000 per file.
- **Empty is not failed**: under 20 visible characters is `skipped`/`empty_text`.
- **No embedding yet**: chunks are written with NULL `embedding`; keyword search
  (`content_tsv`) works from the start, and embedding will fill the NULLs.
- **Order**: `is_latest` files first, so a partial run indexes what answers lead with.
- **Safety**: each file is one transaction, claimed only if its content tag still
  matches what was read; a running sync stamps `heartbeat_at`, and one silent for
  ten minutes is abandoned (`20261029120000_kb_sync_heartbeat`).
- **Measured on UC Old Chem files**: a 299-page spec in 5 s (335 passages), a
  307-page submittal in 6 s, the CO log in 0.1 s (9 passages), a 20-sheet estimate
  in 3 s.

## The Index button and the worker (2026-10-30)

The admin's button never runs a sync in the web process: a full index takes far
longer than a request may. It queues (`queueKbSync`: one `queued` kb_sync_runs
row), and a Container Apps Job, `kbWorkerJob`, started by a PostgreSQL scaler on
that row, claims it (`claimQueuedKbSync`, `FOR UPDATE SKIP LOCKED`) and runs it
(`scripts/kb-worker.ts --once`). The CIP worker's pattern, chosen over running in
the web app (a restart mid-index) and over no button (an operator with a terminal).

- One active sync, queued or running: `kb_sync_runs_one_active_key`. A press while
  one waits or works is 409; `npm run kb:sync` meanwhile is refused the same way.
- A queued sync no worker takes within an hour is closed (*Never picked up*), so
  a missing job cannot block the button for ever.
- The job holds no secret but the database URL; it reads SharePoint as the KB app
  through the managed identity's federated credential.
- The screen is `/knowledge-base/admin`, module admins only (404 otherwise):
  documents by state, passages and how many are embedded, recent syncs, and the
  files that could not be read.

## Keyword search (2026-10-30)

Built before embeddings so answers can be tested on real questions while KB-2
waits. `searchPassages` (`lib/modules/knowledge-base/search.ts`):

- **Any word, ranked by coverage.** The `simple` dictionary keeps identifiers
  but has no stop words or stemming, so the query side drops stop words, ORs the
  remaining words, and ranks by how many a passage holds, then `ts_rank_cd`.
  Requiring every word (`websearch_to_tsquery`) found nothing for natural questions.
- **Variants** stand in for stemming: plural and singular, `AV-1`/`AV1`,
  `1,200`/`1200`. `"Quoted words"` must appear as a phrase.
- **File name and folder count**, normalised first (the parser reads a whole file
  name with an extension as one token).
- **Job number scopes**: a six-digit number matching a project limits the search
  to it and is not itself searched for (`scope.how = from_question`, the same
  vocabulary as `kb_questions.scope_how`).
- **Versions**: current first, archived last, all labelled; at most three passages
  per file.

`npm run kb:eval` measures it against a git-ignored question set
(`.kb-eval/questions.json`): rank of the first file holding the answer, share
found first and in the top five, mean reciprocal rank. The same set is the
before-and-after for embeddings.

## Embeddings (2026-11-10)

`text-embedding-3-small` on the KB's Foundry resource, called through the
OpenAI-compatible **v1 API** (`<host>/openai/v1/embeddings`, the deployment name
as `model`), so no `api-version` has to be chosen or kept current. `embed.ts`:

- **Written by the sync, last.** `embedPending` embeds every indexed passage with a
  NULL vector, current versions first, 64 per request, and writes a vector only
  where there is still none. It reads the backlog from the database, not from the
  sync's list, so everything indexed before KB-2 is covered by the first sync after.
- **What is embedded**: file name, project and location, then the passage. The
  name carries what a page often lacks ("Air Valves submittal, page 14").
- **Failure is partial, never fatal.** Not configured: the sync is `ok` and says
  so. A refusal: the sync is `partial` with the reason, the index is untouched,
  the next sync continues. Tests never reach Azure: `tests/setup.ts` clears the
  `KB_EMBEDDING_*` variables, and the suite uses a fake embedder.
- **Identity**: an API key locally; the managed identity in production (scope
  `https://ai.azure.com/.default`, role *Cognitive Services OpenAI User*), which the
  app also gets so that search can embed a question.
- **Search uses them (next section).**

## Hybrid search (2026-11-10)

`searchPassages` runs two searches over the same scope and merges them:

- **Words**: the keyword search above, unchanged, as one candidate list (up to 200).
- **Meaning**: the question is embedded (same deployment, 2 tries, 5 s timeout,
  an in-process cache of the last 500 questions) and compared with passage vectors
  by cosine. Up to 100 nearest, and only those with similarity >= 0.3
  (`KB_MIN_SIMILARITY`): a nearest neighbour is not evidence by itself. All
  projects: the HNSW index with `hnsw.ef_search = 200`. A chosen project: an exact
  scan (`ORDER BY ... + 0`), because filtering an approximate top-k after the fact
  can return too few.
- **Fusion**: reciprocal rank, `1 / (60 + rank)` from each list, summed; a passage
  both found outranks one only a single list found. A small nudge (0.0005) puts a
  current version above an archived one that scored the same. At most 3 passages
  per document, 20 results.
- **Fallback, said out loud**: not configured, or the embedding call fails, and the
  search answers by words with a `notice` the screen shows. A passage with no vector
  yet is still found by words. `mode=keyword` on the route never calls Azure.
- **Copies collapse**: walking down the fused order, a passage that is the same text
  as one already chosen (Jaccard >= 0.8 on three-word runs, both at least 30 words;
  `duplicates.ts`) goes under it as `alsoIn` (up to 10) and takes no place, and does
  not count against its document's cap. Found on real data: one spec section copied
  into three RTU submittals filled the top four results. Jaccard, not containment,
  so a page with the boilerplate plus a schedule of its own stays a result.
- Each hit carries `matchedBy` (`words`, `meaning`, `both`) and `similarity`.
  `tests/kb-hybrid.test.ts` writes hand-built vectors so every similarity is exact.
- **Not tuned yet.** The threshold and K are defaults from the literature; tune them
  on `npm run kb:eval` (keyword and hybrid side by side) with real questions.

## Re-sort, answers and history (2026-11-11)

Decided 2026-11-10: Claude for both steps (Haiku re-sorts, Sonnet answers) over
an Azure model or a self-hosted cross-encoder; research in the project notes.
Cohere on Foundry is likely closed to the CSP subscription.

- **Key**: `KB_ANTHROPIC_API_KEY`, the module's own, never a fallback to the BAS
  or Change Orders key (`tests/anthropic-key-per-module.test.ts`). Key Vault
  `KB-ANTHROPIC-API-KEY` behind `kbAnthropicApiKeyInKeyVault`.
- **Re-sort** (`rerank.ts`): the top 30 after fusion and collapse go to
  `claude-haiku-5-5` at low effort in one listwise call; it returns the numbers
  that help, best first. Cleaned (only numbers sent, once each), 10 s timeout,
  memoised; any failure leaves the fused order with a notice. Hits carry
  `relevant`. Also runs on the plain search route.
- **Answer** (`answer.ts`): the passages Haiku kept (at most 15; the top 10 when
  there was no re-sort) go to `claude-sonnet-5-5`, structured output: kind,
  answer with [n] citations, missing, conflicts. `finishAnswer` keeps only
  citations to passages sent, renumbers them, and turns an uncited answer into
  "no evidence". No passage kept: no Sonnet call. Output ceiling 4,096 tokens and
  thinking at the model default, both placeholders until the rules are decided.
- **Follow-ups** (`followup.ts`): rewritten by Haiku to stand alone for the
  search; the answer sees the person's words and up to 4 earlier turns as
  context, never as evidence. The earlier projects are kept unless a job number
  is named. Only the starter adds to a conversation.
- **History** (`ask.ts`): every final answer saved with a snapshot of its sources
  (`kb_questions.answer`), citation links in `kb_question_sources`. Failed
  answers are not saved. Shared list at `/knowledge-base/history` (index
  `kb_conversations(updated_at DESC, id DESC)`, migration
  `20261111120000_kb_shared_history_index`), opened at `/knowledge-base?c=<id>`.
- **Limits**: 10 questions per person per minute, in memory.
- **Report a wrong answer** (2026-11-11, `reports.ts`): under each answer, a
  reason (the CHECKed five), optionally a source and a comment; one open report
  per person per answer (a second updates it). Queue for KB module admins on
  `/knowledge-base/admin`; closed as resolved or dismissed with a required note;
  both audited.
- **The answer card shows only what helps** (2026-11-11): answer, citations,
  missing or conflicting evidence when there is any, and each source as file and
  page with an Archived tag when it applies. No project folder repeat, version
  date, timing or passage count.
- **Not built yet**: the real answer rules, `kb:eval` for answers.

## Open questions

- **Shared history and leavers.** `kb_conversations.employee_id` cascades on
  delete, so removing an employee row would remove questions everyone can see.
  Employees are disabled, not deleted, today; revisit before anything deletes
  employee rows.
- Does the folder template ever nest a `2A`, `5A` or `8` code under a different
  parent? The rule matches the code wherever it appears on the path.
