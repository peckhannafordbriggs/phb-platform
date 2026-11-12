# BAS Reports Tab — Implementation Plan

**Date:** 10 November 2026 · **Status:** plan for approval, nothing built
**Inputs:** Jim's "BAS Health Report: Build Spec" (27 Oct 2026); the requirements brief; a read of `main` at `d8e28e7` (10 Nov); the clarifying answers recorded in §A.

**Revised 12 November 2026 (§A, §C):** the presets are no longer locked - the editor's Questions section is a checklist, a preset is a button that ticks a set, and `preset_key` is a label; the per-report cost budget and time cap are gone in favour of one module-level safety ceiling on the Usage page; and the Usage page mirrors Cost Intelligence's *Usage & cost*. Where §B, §D or §F still say "budget_usd" on a definition, "locked", or "Limits", §A and §C are the current word.

---

## A. Decisions made in the clarifying round

| Topic | Decision |
|---|---|
| Standard report | **A preset button, not a lock** (revised 12 Nov). The editor's Questions section lists every enabled shared question as a checklist, grouped by section; *Standard weekly* ticks Jim's 20 and unticks the other shared questions, and the person can tick or untick anything after. `preset_key` is kept on the definition as a label of which preset was last clicked, cleared by the service as soon as the shared selection no longer matches it; it restricts nothing. The report template is unchanged. |
| Daily critical-site preset | **Ships in MVP** as a second preset button: Summary, Space Comfort, Data Health. Same rules. |
| Scope | **Per building by default**, with an optional station subset (one JACE, or a chosen group of JACEs) for buildings with many stations. |
| Analysis engine | **Code computes, AI narrates.** Each predefined question is an analysis function (SQL/TypeScript keyed by equipment type and point role) returning structured findings with actual / expected / duration. The model writes only the status sentence, likely cause and recommended action. Custom questions run through the existing Analyze planner in batch mode. |
| Occupancy | **Trend an occupancy point per station** where possible (role `occupancy_status`); **fall back to a per-building manual occupied-hours setting** when none is trended. The report states which source it used. |
| Sender | **New fenced app registration** `phb-platform-bas-mail`: Graph `Mail.Send` (application), Exchange ApplicationAccessPolicy restricted to `controlls@phb1899.com`, federated identity credential for `phbplat-prod-identity`. Vitis ticket. |
| Recipients | Owner always (enforced server-side); **any address allowed**; non-`@phb1899.com` addresses get a **warn-and-confirm** step and an audit entry. |
| Email content | **PDF attachment from day one**, plus a short HTML summary in the body and a link to the report in the platform. |
| PDF method | **Headless Chromium in the reports job** renders the same HTML the platform shows (one rendering for screen and PDF). Trade-off: a larger job image (~+400 MB); accepted because the job runs in Azure, not on the web app. |
| Schedule | Daily / every N days / weekly on chosen weekdays / monthly; time of day in the **building's time zone**; analysis window from a fixed list (24 h, 3 d, 7 d, 14 d, 30 d) chosen independently. **Missed run = run once on the next tick**, never backfill. |
| Visibility | **Owner + BAS module admins.** Others see only their own reports. Recipients need no platform access. |
| Owner disabled | **Report pauses**; a module admin reassigns the owner, which resumes it. |
| Limits | **One module-level safety ceiling** (revised 12 Nov): $10.00 and 25 minutes per run by default, one row in `bas_report_settings`, editable only by BAS module admins from the *Safety ceiling* card at the bottom of the Usage page; the engine reads it for every run. A run that reaches either half finishes partial and says so. No per-report budget or time cap: the editor's Limits section and the definition's `budget_usd` / `max_minutes` columns were removed, and the create/update APIs refuse those keys with 400. `bas_report_runs.budget_usd` stays as the ceiling in force when the run executed. **Reports kept indefinitely.** |
| Library | 20 seeded predefined questions; **users can save custom questions to a personal library** - from the editor itself, with a *save for reuse* tick on a custom question, so nobody has to visit the Questions page to build a report; **module admins can promote questions to the shared library** — with the caveat below. |
| Layout | Sub-tabs inside Reports: **Reports** (list + create/edit), **Generated** (history), **Library** (predefined + personal questions), **Usage** (cost and time per run, on the same components as the Cost Intelligence usage view, with the module's safety ceiling at the bottom). |
| Validation sites | Build and test on the office building first; hydronic sections validated when the first remote building (Tosi/Linux project) is collected. |

**Caveat on admin-added library questions.** A question answered by an analysis function is code; an admin cannot add one through a form. What an admin *can* add is a shared, planner-answered question (the same mechanism as a custom question) with its applies-to and required-roles metadata. The library therefore has two kinds of predefined question: **computed** (the seeded 20, code) and **planner** (admin- or user-written, answered by the Analyze planner). The UI shows which kind each is.

---

## B. Final product requirements

1. A BAS user can create a report: name, description, building (and optionally a station subset), questions, analysis window, schedule, recipients, cost budget.
2. Questions come from the shared library (computed or planner), the user's personal library, or are typed new. The two locked presets add their fixed question sets as a unit.
3. The platform runs each report on its schedule, unattended, in an Azure job; the user can also run it now.
4. Each run produces a stored report: structured findings, rendered HTML, a PDF. Findings are compared with the previous run of the same report and marked New / Still open / Cleared; open Action Needed items carry forward.
5. Each run emails the PDF from `controlls@phb1899.com` to the owner and the report's additional recipients, with an HTML summary and a platform link; delivery status per recipient is recorded, failed sends retry, and a user can resend.
6. Jim's reliability rules are enforced in code for computed questions (equipment classification by roles, required points, ≥80% coverage, data problems reported only under Data Health, 30-minute / 2-day persistence filters, occupied hours only, exact names, actual/expected/duration) and in the planner's existing rules for custom questions (it already refuses to answer without data and shows provenance).
7. Only the owner and BAS module admins see and manage a report. Owner is always a recipient and cannot be removed; backend-enforced.
8. Usage (cost, tokens, duration) is visible per run and aggregated in the Usage sub-tab.

Out of MVP scope (recorded, not forgotten): custom cron patterns; free-form analysis date ranges for scheduled runs; Word/Excel export; per-building access scoping (remains the planned one-place change in the service layer); collecting Niagara schedules themselves.

---

## C. User interface

**Reports tab → four sub-tabs**, using the existing `bas-shell` tab pattern.

**Reports.** Table of reports the viewer may see: name, building (+ stations), schedule in plain words ("Every Monday 06:00 ET · last 7 days"), questions count, next run, last run with status chip, recipient count, state (Active / Paused / Paused — owner disabled). Row actions: View, Edit, Run now, Pause/Resume, Delete, History. "New report" opens the editor.

**Editor** (one page with sections, not a six-step wizard; saves as draft until activated; revised 12 Nov):
1. *Details* — name, description, building, station subset (default all).
2. *Questions* — the segmented control with three tabs, *Standard weekly* / *Daily critical-site* / *Custom*, each a **checklist** over ONE selection shared across the tabs, visible on a new report before any save. A preset's tab lists its questions grouped by section with a checkbox each (number, text, "section · computed/planner · applies to") and its own *Select all* and *Clear*, which act on that tab's questions only; Daily is a subset of Standard, so a question ticked on one shows ticked on the other, and switching tabs never clears anything. *Custom* lists My questions with checkboxes, the custom questions on this report with a *save for reuse* tick on each, and the text box to type one (this report only by default). A running count at the right of the tab row - "12 questions ticked" - with a *Show selected* toggle that lists the whole selection in order. Mixing is the point: all 20 standard questions plus two custom ones is one report. Order is library order for shared, then My questions, then custom; there is no drag-to-reorder. Saving writes `bas_report_questions` whole. A module admin editing somebody else's report keeps the owner's own questions and types any of theirs in.
3. *Analysis window* — 24 h / 3 d / 7 d / 14 d / 30 d.
4. *Schedule* — frequency (daily, every N days, weekly with weekday picker, monthly on a day), time of day, shown in the building's time zone with the UTC equivalent.
5. *Recipients* — owner shown first, locked, labelled "Report owner · required"; add addresses; external addresses trigger the warn-and-confirm dialog and show an "external" chip.
6. *Review and activate* — summary card ("22 questions · Standard weekly health report + 2 custom"); "Save as draft" or "Activate". No *Limits* section: the module's safety ceiling applies to every run.

**Generated.** All runs the viewer may see, newest first: report, period, status (Queued / Running / Succeeded / Partial — budget or time cap / Failed), duration, cost, delivery (3 of 3 sent, 1 failed), actions: Open, Download PDF, Resend, Re-run. Opening a run shows the rendered report (same HTML as the PDF) with the Not Monitored list and the New / Still open / Cleared markers.

**Library.** Shared library (section, question, kind, applies to, required roles, enabled) — read-only for users, editable for module admins (planner-kind only); personal library below it (edit, delete, "used in N reports"), with its *Add question* box. The read-only overview; a report's questions are chosen in the editor.

**Usage** (revised 12 Nov). The same page as Cost Intelligence's *Usage & cost*, on the same shared components (`components/ui/Usage.tsx`): a 7 / 30 / 90 days toggle; tiles for Spend, Runs, Average per run, Tokens and "<Month> so far"; the spend-per-day bar chart; a segmented *By report / By building* table with runs, tokens, spend, per run and the proportion bar; and a *Most expensive runs* table (run, report, building, status chip, started, spend) whose rows open the run. Every figure is over the finished runs the viewer may see (owner, or every report for a module admin), counted on the day they finished in New York. At the bottom, the **Safety ceiling** card: the module's one ceiling, shown to everyone and editable by BAS module admins, with the explanation that a run which reaches it finishes partial and says so. Colours are the BAS module's. The same view is also *Settings → Usage* (one component, two routes), so the figures and the ceiling are reachable from the module's admin surface; the Reports bar is unchanged.

**Settings tab** swaps the module bar for a bar of its own, as Reports does: *Back · General · Usage* - *General* the screen Settings always was, *Usage* the view above. Both bars are data on one shared shape.

**Settings tab (existing) gains** a per-building *Occupied hours* field (weekday schedule) used as the occupancy fallback, and shows per station whether an `occupancy_status` point is trended.

---

## D. Technical architecture

### D1. Data model (PostgreSQL, Prisma, `bas_` prefix)

| Table | Purpose | Key columns |
|---|---|---|
| `bas_report_definitions` | One configured report | id, owner_employee_id, name, description, site_id, station_ids[] (null = all), preset_key (null / `health_weekly` / `health_daily`), window (`24h`…`30d`), schedule_kind, schedule_params (jsonb: interval days, weekdays, day of month), time_of_day, next_run_at (UTC), state (`draft`/`active`/`paused`/`paused_owner_disabled`), budget_usd, created/updated |
| `bas_report_questions` | Ordered questions on a report | definition_id, position, kind (`library`/`personal`/`inline`), library_question_id / personal_question_id / inline_text |
| `bas_library_questions` | Shared library | id, key, section, text, kind (`computed`/`planner`), analysis_fn (for computed), applies_to_equipment (text[]), required_roles (jsonb), min_coverage (default 0.80), enabled, added_by, created_at |
| `bas_personal_questions` | A user's saved custom questions | employee_id, text, created_at |
| `bas_report_recipients` | Additional recipients only (owner derived from definition) | definition_id, email, is_external, confirmed_by, confirmed_at, added_by |
| `bas_report_runs` | One execution; also the work queue | definition_id, status (`queued`/`running`/`succeeded`/`partial`/`failed`), trigger (`scheduled`/`manual`), period_start/end, timezone, started_by, budget_usd, cost_usd, input_tokens, output_tokens, started_at, heartbeat_at, finished_at, error, report_json (jsonb), report_html, pdf (bytea or blob reference — see D6), previous_run_id |
| `bas_report_findings` | Structured findings per run | run_id, question_key, equipment_id, issue_code, priority, evidence (jsonb: actual, expected, duration or percent, when), likely_cause, recommended_action, fingerprint (sha of question+equipment+issue), state (`new`/`still_open`/`cleared`), first_seen_run_id |
| `bas_report_deliveries` | One row per recipient per run | run_id, email, status (`pending`/`sent`/`failed`), attempts, last_error, graph_message_id, sent_at |
| `bas_site_occupancy` | Manual occupied-hours fallback | site_id, weekday, start, end |

The owner is never a recipient *row*; the worker always adds the owner's employee email at send time, so no UI or API path can drop it. Site time zone already exists on `bas_sites`.

### D2. Jobs (Container Apps, same patterns as CIP and the backup)

- **`bas-reports-scheduler`** (Azure job `<baseName>-bas-reports-sched` since 2026-11-11: the full word made the name 34 characters against Azure's cap of 32, and the first deployment failed on it; the worker is `<baseName>-bas-reports-worker`) — cron every 15 minutes (UTC). For each active definition with `next_run_at <= now`: insert one `queued` run and advance `next_run_at` in the same transaction (missed ticks collapse into one run). Pauses definitions whose owner is inactive.
- **`bas-reports-worker`** — KEDA PostgreSQL scaler on `count(*) where status='queued' or (running and heartbeat stale)`, exactly like `cip-worker`; claims a run with `FOR UPDATE SKIP LOCKED`, heartbeats, executes, writes results, sends mail. Max 2 parallel; 30-minute replica timeout.
- Both use one image (`bas-reports:<sha>`, Node + Playwright Chromium), built by `deploy.yml` on merge like `cip-worker`, behind `enableBasReports` in `main.bicep` with the image passed as `basReportsImage`. Secrets by reference: `DATABASE-URL` (writes) and `BAS-ASK-DATABASE-URL` (the read-only role for planner SQL), `ANTHROPIC-API-KEY`.
- "Run now" from the UI inserts a `queued` row; the worker's scaler picks it up within its polling interval.

### D3. Engine (in `lib/modules/bas/reports/`)

1. **Resolve scope**: site → stations → equipment → points with roles; occupancy source per station (trended `occupancy_status` point, else `bas_site_occupancy`, else none).
2. **Coverage**: per required point, percent of the period with readings at the point's measured interval (from `bas_readings` + `bas_data_gaps`); computed in SQL, once per run.
3. **Classify equipment** from roles present (hydronic if `*_valve_cmd`; DX if `compressor_*` or `cooling_stage_cmd`; gas/electric heat if `heating_stage_cmd`), per Jim's Step 1; decide Not Applicable per question.
4. **Point inventory** per question: required roles present on applicable equipment and ≥ min coverage → run; else Not Monitored with the missing roles named.
5. **Analysis functions** (computed questions): pure functions over a fetched, downsampled series per equipment, each returning `Finding[]` with evidence numbers and applying the persistence filters (≥30 min during occupied hours, or ≥2 days). Data-quality detections (flat-line, out of range, stale) come from the plausibility and gap logic and are routed to Data Health only, and the affected points are excluded from the equipment questions.
6. **Planner questions** (custom / personal / admin planner-kind): call the existing Analyze planner with the report's scope and period as fixed context, through `bas_analyze`, with the SQL guard, provenance and no-data handling it already has; the answer and its provenance become a report section. Budget-aware: stop issuing planner calls when the run's remaining budget is below the per-call estimate.
7. **Narrative**: one model call per section (not per finding) with the structured findings as input, asking for the status sentence, likely cause and recommended action per finding, in the `docs/11` voice; the model cannot add findings or change numbers (the renderer takes numbers from the findings, not the prose).
8. **Comparison**: fingerprints vs the previous run of the same definition → New / Still open / Cleared; Action Needed items not cleared carry forward with first-seen date.
9. **Status roll-up**: section status from its findings' priorities; building status from sections; Not Applicable / Not Monitored never affect it.
10. **Render**: report JSON → HTML via a server-rendered React template (shared with the Generated view) → PDF via Chromium.
11. **Persist**: run row (json, html, pdf, cost, tokens, timing) and findings.
12. **Deliver**: see D5.

### D4. AI usage and cost

- Model calls per run: one per rendered section (≤ 9) plus one per planner question. Tokens metered from the API response into `input_tokens` / `output_tokens` / `cost_usd` using the same pricing table approach as CIP; the run stops issuing calls at `budget_usd` and is marked `partial` with the reason in the report header.
- The production key is still a personal key (accepted risk until cutover); the Usage tab makes report spend visible so the key's bill is explainable.

### D5. Email

- Reuse the Graph client, credential (managed identity + federated credential) and attachment helpers from `lib/modules/change-orders/mail`, parameterised by a second app registration and mailbox: env `BAS_MAIL_CLIENT_ID`, `BAS_MAIL_TENANT_ID`, `BAS_MAILBOX=controlls@phb1899.com`.
- Vitis **Request 7**: app `phb-platform-bas-mail`; application permission `Mail.Send` with admin consent; Exchange ApplicationAccessPolicy restricting it to `controlls@phb1899.com`; federated identity credential for `phbplat-prod-identity` (same issuer/subject as the other three apps); one dev client secret over Teams. Prerequisite: confirm the mailbox exists and who owns it.
- Send gate: a BAS-specific `BAS_REPORTS_ALLOW_SEND` flag (default false in non-production), mirroring `PHB_ALLOW_SEND`.
- Per recipient: one `bas_report_deliveries` row, idempotency on (run, email); up to 3 attempts with backoff; status and Graph message id recorded; "Resend" creates a new attempt for failed rows only. The PDF is attached when under Graph's simple-upload limit (the CO helpers already handle sizes).

### D6. Storage of PDFs

Start with `bytea` in `bas_report_runs.pdf` (reports are a few hundred KB; indefinite retention at one building is tens of MB a year). Tripwire written into the runbook: move to the existing backup storage account's blob service (a second container) if the table exceeds ~2 GB or more than ~20 buildings report weekly.

### D7. Permissions

- Tab and API: `requireModuleAccess('bas')`. Manage (edit, delete, run, recipients): owner or `requireModuleAdmin('bas')`. All checks in the service layer with the employee as a parameter, as the module already does, so per-site scoping can be added later in one place.
- Owner recipient added at send time from the employee record; the recipients API refuses to add or remove the owner's address.
- External recipient: service requires `confirmed=true` in the request after the UI warning; writes `bas.report_recipient_added` with `is_external`. All writes audited (`bas.report_created/updated/deleted/run_requested/recipient_*`).
- Scheduler pauses definitions whose owner employee is inactive and records why; module admin "Transfer owner" resumes.

---

## E. End-to-end data flow

User (with the BAS grant) creates a report → picks a preset or library/personal/inline questions → sets window and schedule → adds recipients (owner locked, external confirmed) → activates (next_run_at computed in the site's zone) → scheduler tick inserts a queued run → worker claims it → resolves scope, coverage, occupancy source → classifies equipment, decides Not Applicable / Not Monitored → runs analysis functions and planner questions within budget → compares with previous run → asks the model for narrative per section → renders HTML and PDF → stores run, findings, pdf → sends from `controlls@phb1899.com` to owner + recipients with PDF, summary and link → records deliveries → Generated and Usage tabs show it.

---

## F. Phases

Each phase ends with a PR (Claude Code opens it; owner merges), tests green, runbook section written.

**Phase 0 — Prerequisites (no code).** Vitis Request 7 (sender app); confirm `controlls@` mailbox; ask the controls team to trend an occupancy/schedule-status point on the office JACE (role `occupancy_status`); decide default budget per run. *Done when:* ticket sent; mailbox confirmed; occupancy point requested.

**Phase 1 — Schema, library seed, definitions CRUD, Reports/Library UI (no runs).** Tables in D1; seed the 20 questions as `computed` with applies-to and required roles from the spec; editor with presets, library picker, personal library, schedule, recipients (owner lock, external confirm), budget; list view. *Done when:* a report can be created, edited, paused, deleted; owner cannot be removed via API (test); external address requires confirmation (test); `next_run_at` computed correctly across DST (test).

**Phase 2 — Engine core on the office data, manual run, HTML view.** Coverage, classification, inventory, occupancy resolution; analysis functions for **Data Health (20)**, **Space Comfort (3, 4, 5)**, **Schedules (19)**; comparison and fingerprints; narrative call; HTML render; a dev script runs a report and stores it; Generated view shows it. *Done when:* a run on the office building stores findings, marks the hydronic sections Not Applicable and the unmonitored ones Not Monitored with the missing roles, and the flat-lined `points_RoomT` appears under Data Health only (Jim's checklist items 1–4 on what the office can show).

**Phase 3 — Jobs.** Scheduler and worker in `main.bicep` behind `enableBasReports`; image build in `deploy.yml`; Run now from the UI; budget and time caps; partial status. *Done when:* a scheduled run fires unattended at the configured local time, a missed tick produces one run, and a manual run is picked up within one polling interval.

**Phase 4 — PDF and email.** Chromium render in the job image; Graph send as `controlls@` (depends on Phase 0); deliveries, retries, resend; summary body and link; `BAS_REPORTS_ALLOW_SEND`. *Done when:* the owner and two added recipients (one external) receive the PDF; a forced failure retries and shows Failed with Resend; the owner is included even when the definition has no recipient rows.

**Phase 5 — Remaining computed questions.** VAV (6–8), AHU/RTU (9–12), Hot/Chilled Water (13–14), DX (15–18), Summary roll-up (1–2); the daily preset. Each function ships with fixture-based tests (synthetic series with known answers) because the office lacks most of these points. *Done when:* every one of the 20 has a function and a test; both presets render the full template.

**Phase 6 — Custom and planner questions, Usage tab.** Planner integration in batch mode with budget awareness; personal library save/reuse; admin promotion to shared library (planner-kind); Usage sub-tab. *Done when:* a report mixing 3 computed + 2 custom questions runs end to end; a custom question with no data says what is missing (planner's existing behavior) and is recorded as such; spend is visible.

**Phase 7 — Validation on a second (hydronic) building.** When the first remote building is collected: run the standard report on both; Jim's five checklist items; a deliberately removed point shows Not Monitored; second run marks New / Still open / Cleared. *Done when:* Jim signs off the checklist.

---

## G. Testing

Unit tests per analysis function with synthetic series (known starts/hour, known % in band, known delta-T); coverage calculation against seeded gaps; classification from role sets; Not Applicable / Not Monitored decisions; fingerprint stability across runs and New/Still open/Cleared transitions; data-health routing (a flat-lined point produces no equipment finding); schedule maths (every-N-days, weekdays, monthly, DST change, missed tick → one run); owner-recipient enforcement at the API and at send time; external-recipient confirmation; permissions (non-owner non-admin denied; admin allowed; paused-on-disabled-owner); budget cap → `partial`; delivery retry and idempotency; planner question with no data; real-psql tests for the new tables and role grants (the `bas_analyze` allowlist script must learn the new `bas_report_*` tables — it refuses to run on unknown `bas_*` objects by design); deploy guards for the new job, flag and image parameter; Jim's two-building checklist as an acceptance script.

---

## H. Risks and how the plan handles them

| Risk | Handling |
|---|---|
| Office data can exercise only ~6 of 20 questions | Fixture tests for every function; honest Not Monitored output; hydronic validation deferred to the remote-site building (Phase 7). |
| Occupancy unavailable | Trended point where present, manual hours fallback, source stated in the report; Phase 0 asks for the office point. |
| `controlls@` sending depends on Vitis | Phase 0 ticket now; Phases 1–3 do not depend on it; email is Phase 4. |
| Report cost and the personal API key | Per-run budget, `partial` status, Usage tab; one narrative call per section, not per finding. |
| Finding identity for New/Cleared | Computed engine with deterministic fingerprints; planner answers are not fingerprinted (they are shown, not tracked). |
| Chromium in the job image | Accepted size cost for one rendering; job-only, never in the web image. |
| Duplicate or missed runs | Transactional enqueue with `next_run_at` advance; `SKIP LOCKED` claim; heartbeat and stale-run reclaim; idempotent deliveries. |
| Time zones | Schedule stored as local time + site zone; `next_run_at` computed in UTC each advance; DST test. |
| Large buildings / many stations | Station subset in scope; downsampled series per equipment; 30-minute job timeout with `partial`. |
| Read-only grant script | `setup-bas-analyze-role` must be extended for new tables — it fails loudly otherwise, by design. |

---

## I. Immediate next steps

1. Send Vitis Request 7 (sender app for `controlls@phb1899.com`); confirm the mailbox and its owner.
2. Ask the controls team to add a trended occupancy/schedule point on the office JACE (role `occupancy_status`).
3. Approve this plan; then Phase 1 prompt to Claude Code (schema + library seed + CRUD + UI), ending with a PR.
