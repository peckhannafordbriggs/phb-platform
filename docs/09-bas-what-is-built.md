# BAS module — what is built

A record of the Building Automation module as it stands. Companion to
`08-bas-and-niagara.md`, which explains *why* it is shaped this way; this one
says *what exists*.

Failure modes are in `runbook.md` under *BAS — Building Automation module*.

B7's plan, as written before it was built, is `docs/B7_settings_and_hierarchy_plan.md`.
B8's is `docs/B8_point_management_plan.md`; B8.1 (the schema) and B8.2 (the
read-only Points list) are built and the rest is not started.

**Last updated:** 17 September 2026 — a third pass. Every figure in it was read
from the repositories, the git logs, the live database or the live stations on
that day, and it **agrees with `phb-bas/bas-collector/ProjectStatus.md`**, which
is the pipeline's own record written the same day from the same sources. Where
the two documents describe the same event they carry the same number; where an
earlier version of this document had a different number, the correction is
noted rather than silently applied. The previous pass (8 September) described
one JACE, synthetic data, three outages and a module with nothing setting
`equipment_id`. None of that is true now.

---

## Two repositories, one system

**This document describes the whole BAS system, which spans two repositories.**
Read that before checking any claim in it, because which repository a claim falls
under decides where to look and what can hold it to account.

| | Owns | Where |
|---|---|---|
| **`phb-platform`** (this repo) | The `bas_*` schema and migrations, the API routes, the Building Automation module and its three screens, the module guard, the BAS tests, the verification tooling — `bas-import`, `bas-checksum`, `bas-verify-import`, `bas-health-oracle`, `bas-tables` — and these docs | `prisma/migrations/`, `app/(modules)/bas/`, `app/api/modules/bas/`, `lib/modules/bas/`, `tests/bas-*.test.ts`, `scripts/bas-*.ts`, `docs/` |
| **`phb-bas`** | `bas-collector` — the Python collector, `healthcheck.py`, `Backup-BasDatabase.ps1`, `Test-BasRestore.ps1`, `setup_backup_role.sql`, `Install-BasTasks.ps1`, its tests — plus `bas-db` (retired), `bas-mcp` and `bas-grafana` | those directories at the repo root, checked out locally with `C:\dev` **as** the repository root |

**This is the module's view. The pipeline's view is
`phb-bas/bas-collector/ProjectStatus.md`.** Each points at the other rather than
restating it: what the collector does on a pass, what the office building's
points are and what was found in them, and the operational record of the
collector host are there; the schema, the screens, the API and the platform's
tests are here. The outage and backup records appear in both because both
repositories are implicated in them, and the figures are identical by
construction.

**The database is the seam, and it is the only one.** The collector knows Niagara
and nothing about the platform. The platform knows the schema and nothing about
Niagara. Neither can break the other except through the database — which is the
property that makes them separately deployable, and, as the backup incident
below shows, also the place where a shared setting couples them without anyone
noticing.

**Neither repository's tests can exercise the other.** `npm test` here covers the
schema, the module and the tooling, and reaches none of the collector, the
dashboards, the MCP server or the backups. The reverse holds too. So a claim in
this document is checkable in `phb-platform`, checkable in `phb-bas`, or
checkable in neither because it is about the JACE, the network or an operational
event — and it is worth knowing which before going looking.

Everything below that belongs to the other side is labelled, either in a repo
column or inline as **(phb-bas)**. Nothing in this document should send a reader
hunting through `phb-platform` for a file that was never in it.

---

## In one paragraph

Two Niagara stations — a lab JACE and **PH+B's own office building at Steel
Place** — are read over oBIX every fifteen minutes by a small Python collector
and written into the platform's PostgreSQL database, where they are kept
permanently. The office has 26 real points and history back to February 2024;
the lab has four synthetic ones. The platform's Building Automation module reads
that data in three tabs; Grafana and Claude Desktop read the same tables. Nothing
is installed on either controller, the account used to read them cannot write
back, and the collector reads its station list and logins from the platform
database, entered through the module's own Settings tab.

---

## The pieces

| Piece | Repo | Where it lives | What it does |
|---|---|---|---|
| **PHBoffice** | — | PHB Steel Place, `10.228.100.210`, Niagara **4.10.0.154** | PH+B's own office. One rooftop unit, ten VAVs. 26 active points, history to 21 Feb 2024 |
| **SpringGroveLabComputer** | — | the lab, `196.1.1.213`, Niagara 4.15.4.24 | Four synthetic points logged every 5 min, 41.6 h buffer. Not PH+B's asset |
| **`bas_collector` Niagara account** | — | on each station | Read-only, `HTTPBasicScheme`. The only thing added to a JACE |
| **Collector** | `phb-bas` | `bas-collector/` | Python. Reads oBIX every 15 min, writes to Postgres. Stations and logins from the database |
| **`bas_*` tables** | `phb-platform` | `prisma/migrations/`, live in the platform database | 14 tables, 6 views, 20 CHECK constraints, 3 triggers. Permanent |
| **Building Automation module** | `phb-platform` | `app/(modules)/bas/`, `app/api/modules/bas/` | Three tabs behind the platform's own login and grants |
| **Grafana dashboards** | `phb-bas` | `bas-grafana/`, served at `localhost:3001` | Second view onto the same data. Development and verification tool, not a deliverable |
| **`bas-mcp`** | `phb-bas` | `bas-mcp/` | Lets Claude Desktop query the data, read-only. Superseded by B5 when that ships |
| **Nightly backup** | `phb-bas` | `bas-collector/Backup-BasDatabase.ps1`, 02:15 to OneDrive, as `bas_backup` | Load-bearing — see *The backup incident* |

Paths are relative to the repository named beside them. A dash means the piece
is in neither repository, because it is a fact about a building rather than a
file. A third station row, `Side`, exists as a `via_parent` placeholder under
PHBoffice in a project called Liberty; it was created through the Settings tab
on 17 September at 10:02 by the module's administrator, has no points and no
login, and is skipped by the collector. Whether it is staging for a real
building is not recorded.

---

## What is built

| Phase | What | Commit |
|---|---|---|
| **B1** | Twelve tables, six views, the trigger, the data import | `56f2811` (2026-08-21) |
| **B1 tests** | Tests for B1, plus a guard that refuses to run against a stale test database | `92eacfd` (2026-08-21, with B2) |
| **B2** | Module registration, `withBas` guard, tabbed shell | `92eacfd` (2026-08-21) |
| **Three fixes** | Vocabularies into the seed, SQL comments restored, `postinstall` forcing `prisma generate` | `6aa6521` (2026-08-21) |
| **Content verification** | `scripts/bas-checksum.ts`, `npm run bas:verify` — comparison by content, not row counts | `278b723` (2026-08-24, with B3) |
| **B3** | Collection Health screen, time range and building filter | `278b723` (2026-08-24) |
| **Cutover (B6)** | Collector retargeted at the platform database, Grafana and MCP repointed | `abcacf3`, `78776fd` **(phb-bas)**, 2026-08-24 |
| **B4** | Point Explorer, tabbed layout | `e76eba4` (2026-08-24) |
| **Redesign** | Module accent scope, chart accent and chrome, headroom as the hero, the trend zooms | `5235b76` … `752b8af` (2026-08-28) |
| **B7.1** | A project level above buildings, and a place for station credentials | `61336b6` (2026-09-08) |
| **B7.2–B7.4** | The Settings tab, behind a module-admin permission that is **not** platform admin | `1669e63` (2026-09-08) |
| **B7.5–B7.6** | Credential audit gains a username; the BAS filters grow up to the project level | `a409366` (2026-09-09) |
| **B7.5 (collector)** | The collector reads its stations and decrypts its logins from the database; TLS pinned per station | `12bd590` **(phb-bas)**, 2026-09-09 |
| **One station never stops another** | A station with no login is `AWAITING`, amber, no run row; `discover` reads the database too | `09ee0ae` **(phb-bas)**, `37fd2fb` (2026-09-16) |
| **The office JACE** | PHBoffice registered, discovered, first synced, then classified in SQL | 2026-09-16 → 17; the classification has no commit — see *Not built* |
| **Completeness** | A first sync takes everything the station holds; every pass compares the station's count with ours; `add_bas_completeness` | `e15f4bb` **(phb-bas)**, `6e21be2` (2026-09-17) |
| **Measured horizon, visibility, the clock** | The roll horizon measured from a full buffer's span; the verdict read by the view, the screen and the health check; the station's clock offset recorded; `add_bas_measured_horizon_and_visibility` | `2b88ba3` **(phb-bas)**, `09e0041` (2026-09-17) |
| **The backup gets its own role** | `bas_backup`, `BAS_BACKUP_URL`, `.verified` markers, the health check watches freshness | `d77a0cb` **(phb-bas)**, on `fix/backup-role-and-monitoring`, **not yet merged** on 2026-09-17 |
| **Axis precision** | The trend's y-axis chooses round ticks at every zoom, decimals by unit; the stored reading is untouched | `fix/bas-chart-axis-precision` (2026-09-18) |

### Test count

**1,343 tests, measured 2026-09-17** on `main` after `09e0041`, of which
515 are in `tests/bas-*.test.ts`. The 10 September figure was
1,272; the growth is completeness and the measured horizon. Every collector suite
*(phb-bas)* is listed under *Tooling*; they are not in this number and cannot be.

---

## The database

**Fourteen** tables under `public` with a `bas_` prefix, managed by Prisma.
Counted from `@@map("bas_*")` in `prisma/schema.prisma`.

```
bas_orgs
 └── bas_projects                  a job — added by B7.1
      └── bas_sites                a building
           └── bas_stations        a JACE (or a Supervisor). Now three rows
                └── bas_points     one trended value. 39 rows, 30 active
                     └── bas_readings   the numbers. 42,652 on 17 Sep
           └── bas_equipment       RV, VAV-1 … VAV-10 at the office
```

**`bas_projects` sits above buildings**, which is the order the business works
in: a job comes first and the buildings belong to it.

Plus `bas_point_roles` and `bas_equipment_types` (controlled vocabularies, 91 and
25 rows, seeded), `bas_point_links` (empty — see *Classification*),
`bas_station_credentials` (see *Security*), and three operational tables —
`bas_sync_checkpoints`, `bas_ingest_runs`, `bas_data_gaps`.

Six views, all prefixed `bas_v_`. That prefix is **load-bearing**:
`bas_v_data_dictionary` selects objects matching `bas\_%`, so an unprefixed view
would be invisible to it and therefore invisible to the AI.

### What the 17 September migrations added

Two migrations, both on the collector's account of a pass, because the
completeness check found things the schema had no column for:

| Column | Table | What it holds |
|---|---|---|
| `completeness`, `completeness_note`, `completeness_checked_at` | `bas_sync_checkpoints` | `unknown` / `complete` / `backfilling` / `incomplete` (a CHECK), and the comparison as a sentence |
| `station_count`, `station_start`, `station_end`, `held_count` | `bas_sync_checkpoints` | What the station reported and what we hold inside its span, at the last pass |
| `observed_span_s` | `bas_sync_checkpoints` | The station's `end − start`, re-measured every pass. The **current** span, for display |
| `shortest_full_span_s` | `bas_sync_checkpoints` | The **shortest** `observed_span_s` ever recorded while the buffer was full. The guard. Written as `LEAST(existing, new)`, so it only gets shorter (`add_bas_shortest_full_span`, 2026-09-18) |
| `points_incomplete`, `points_backfilling` | `bas_ingest_runs` | A run with any incomplete point is `partial`, never `ok` |
| `clock_offset_s`, `clock_measured_at` | `bas_stations` | Station clock minus host clock, from `/obix/about`. PHBoffice: **+1336 s** |

`bas_v_collection_health` was replaced to carry all of these plus
`measured_horizon_s`, `horizon_s` (measured else configured) and
`horizon_source`, and its `roll_risk` is computed from `horizon_s`. That is what
let a change-of-value point stop reading `roll_horizon_unknown`: it needs only
`capacity` filled in, and once the station reports `count >= capacity` the span
is the horizon. See `WHY-ITS-BUILT-THIS-WAY` § 44 and `runbook.md` → *A BAS run
says `ok` and a point holds nothing*.

Replaced again on 2026-09-18 (`add_bas_shortest_full_span`), and the horizon a
point is judged against changed meaning: `measured_horizon_s` is now the
**shortest** full-buffer span ever observed — `LEAST(shortest_full_span_s,
current span)` — not the latest, and three columns were appended:
`shortest_full_span_s`, `current_full_span_s` and `horizon_state`
(`measured` / `configured` / `not_full` / `unknown`). `roll_risk` gained
`buffer_not_full`: the station reports fewer records than capacity, so nothing
has been overwritten and the point is in no risk figure. The Collection Health
table and the Settings Points list both render the horizon through one
`describeHorizon`, so the three states are named identically on both. See
`WHY-ITS-BUILT-THIS-WAY` § 48 and `runbook.md` → *The roll horizon column shows
two numbers*, *A point reads "Not full yet"*.

### Four invariants

**Point identity is a surrogate key, never a name.** A point renamed in Niagara
becomes a new row rather than silently reinterpreting years of history.

**Every timestamp is UTC.** Local time is display only. There is no way to unwind
a DST bug afterwards. (A station whose *own* clock is wrong is a different
matter, and is recorded rather than corrected — see *Proven in operation*.)

**`bas_readings` carries no names, units or equipment.** Denormalising those
multiplies storage roughly 5× and turns a rename into a billion-row rewrite.

**History names are stored exactly as Niagara returns them**, `$`-hex escapes
included. That string goes into the oBIX URL verbatim.

### `roll_horizon_s` is maintained by a trigger

Not a generated column. Prisma reads `GENERATED ALWAYS AS` as a default it cannot
express and proposes an `ALTER … DROP DEFAULT` that PostgreSQL rejects on a
generated column — which permanently blocks every later migration. Prisma ignores
triggers, so a trigger keeps the value correct and the schema diff empty.

**`schema.prisma` is not the whole schema.** Three triggers, **20** CHECK
constraints (13 in `add_bas_tables`, one each in `add_bas_projects`,
`add_station_tls_and_display_name` and `add_bas_point_label_and_visibility`,
two each in `add_bas_completeness` and `add_bas_inactive_reason`) and the six
views live in the migration SQL. Prisma models columns and indexes; it ignores
constraints and triggers.

---

## The screens

One module, **three** tabs — real routes, not client-side state, so each is
bookmarkable and each guards itself independently. Listed in
`app/(modules)/bas/tabs.ts`, which is the one place that knows they exist. A
fourth, **B5 "Ask"**, is designed and is not a tab yet — see *Not built*.

### Collection Health — `/bas`

In render order:

| | What |
|---|---|
| **Hero tile** | Headroom — *how long until data starts being lost* — with the per-point risk breakdown behind it |
| **Run chart** | Records written per collector run, full width |
| **Four tiles** | Active points (with a live *n of m reporting* badge), total readings, unclassified points, time since the newest reading |
| **Station count against ours** | The completeness check, surfaced (17 Sep). Red from one `incomplete` point, amber for `backfilling` or `unknown`, green only when every active point was checked and agrees. Lists each such point by name with both numbers |
| **Tables** | Per-point status — now with a *Completeness* column and a *measured* mark on the roll horizon — recent collector runs, recorded data gaps |

**Why the completeness card is always rendered, even when green.** The check it
reports spent a day writing verdicts to a column nothing read — which is the
28 August failure again, gaps recorded correctly and unread. A card that only
appeared when something was wrong could not be told apart from a check that had
stopped running.

**Two things here have semantics that must not drift.** Headroom over a partly
unknown set never renders as a bare number — the rule and its reasoning are in
`08`. And *unclassified points* is amber by design: a point with no role is
invisible to role-based questions, which is a backlog item rather than a fault.
`backfilling` is amber for the same reason: a large first sync still paging
resolves itself. `incomplete` is red like `data_lost`, because the only thing
between it and lost is the station's buffer rolling.

Semantic tone lives in one place, `app/(modules)/bas/tone.ts`.

### Point Explorer — `/bas/points`

Point picker, trend chart, and tiles for latest, average, range, readings versus
null records, and distinct values.

**Distinct values, not standard deviation**, for judging whether a sensor is
alive. A standard-deviation threshold is unit-dependent and untunable across
buildings — it missed a sensor frozen at 64.5 with σ = 0.08. Distinct-value count
is unit-independent, and it is what found the dead sensor at the office (below).

**The chart breaks across gaps rather than interpolating.** Three mechanisms,
because a break alone reads as a rendering artifact: an inserted null with
`connectNulls={false}`, a shaded band, and a written list of gaps beneath the
chart. See `WHY-ITS-BUILT-THIS-WAY` § 30.

**Drag across the plot to zoom; Reset returns.** The zoom is a domain change,
never a filter on the data, so no zoom can smooth over a gap. **The curve is
`monotone`**, so it never draws a peak the sensor did not record. **One point at
a time**, so two units never share an axis.

**The y-axis is chosen by the chart, not by Recharts.** Round ticks at every
zoom, a fixed number of decimals by the kind of unit (temperature 1, percent 0,
pressure 2, otherwise 2), one more in the tooltip, and a gutter sized to the
widest label. The readings themselves are float32 as Niagara sent them and are
rounded nowhere but the label. `runbook.md` → *The trend chart's y-axis prints
long decimals*; `WHY-ITS-BUILT-THIS-WAY` § 50.

### Analyze — `/bas/analyze` (B5, 2026-09-21)

A question in plain English; one `SELECT` written by the model; the answer
beside **what was actually queried**. The BAS grant is enough — the tab reads
what the other tabs read and nothing more.

What is on screen for every result that ran, and cannot be collapsed: the
hours of recorded gaps inside the resolved time range (clipped to it, from
`bas_data_gaps`), the points in scope whose roll horizon is unknown, the time
range as resolved, the points and sites by name, what the database holds for
them, the row count, and the SQL. All of it computed by the platform after the
query ran — the model's only contribution to that panel is the time range and
point ids it declared, and both are checked against the database and labelled
where they could not be.

Five kinds of result, rendered from the kind and never from an answer string:
`answered`, `no_data` (zero rows, or one row that is all NULL — the summariser
is never invoked), `clarify`, `cannot_answer` (with every SQL that was tried),
and `not_configured`. One retry at most, said on screen.

`lib/modules/bas/analyze/`: `sql-guard.ts` (tokenizer, one SELECT only),
`role.ts` (the allowlist, shared by the setup script and the refusal tests),
`pool.ts` (READ ONLY transaction, cursor, extended protocol, timeout, row
cap), `provenance.ts`, `schema-context.ts` (built from
`bas_v_data_dictionary` plus live counts), `planner.ts` (the Anthropic calls),
`service.ts` (the order of operations), `rate-limit.ts`. Tests:
`tests/bas-analyze-*.test.ts`, 74 of them, against the real test database
through a throwaway copy of the role.

Verified live on 2026-09-21 with the real model over the PHBoffice and Spring
Grove data — `docs/bas-b5-verification.md` has every result verbatim. The
live runs found three faults the scripted tests could not (a widening rule
keyed on the wrong thing, an undeclared period beside `now() - interval`, a
30-day average from ten days of readings), and each became a platform rule:
`periodUndeclared` and `coverageShortfall` on every result, both amber.

**Not yet:** production wiring of the two variables into Key Vault, and the
role on the Azure database.

### Settings — `/bas/settings`

**B7.2–B7.6, shipped.** What gets collected: projects, buildings, stations and
their credentials, created and edited through the UI. Behind
`requireModuleAdmin('bas')`, which is **not** the platform admin flag —
`module_grants.is_module_admin` carries administrative rights over exactly one
module, and denies with 404 rather than 403. One employee holds it.

Why the separate permission: viewing building data and changing what gets
collected are different privileges. A misconfigured station stops collection
silently, and silent is the failure mode this module is built against. Putting
it behind the platform admin flag would have handed the employee directory to
whoever adds a building. See `WHY-ITS-BUILT-THIS-WAY` § 37.

**Credentials are write-only.** A station's Niagara login is encrypted with
AES-256-GCM under `BAS_CREDENTIAL_KEY` into `bas_station_credentials`, written
through `PUT /stations/{id}/credential`, and **never returned by any route**: the
settings query selects the username and `updated_at` and not the ciphertext,
with a comment saying a column never selected cannot be leaked by a later change
to the serialiser. The collector *(phb-bas)* decrypts with the same key; the
cross-language round trip is asserted by its `test_targets.py` against this
repository's `credentials.ts`. The `bas_v_data_dictionary` view — which feeds an
LLM prompt — excludes the credentials table by name.

**Every settings write records an audit event**, `bas.project_created`,
`bas.building_created`, `bas.station_created`, `bas.credential_set` and their
updates and deletes, with the actor. That is how the `Side` station row above
was explained in two queries.

**Points (B8.2).** Expanding a station lists its points, read-only: label,
Niagara name (the oBIX key, in full), the station's own name for the history,
role, equipment, collected, completeness and visible. Loaded on expansion from
`GET /settings/stations/{id}/points`, not with the tree; the count on the
station row is a correlated `count(*)` on `bas_points` alone, so it is right
whether or not anyone expands. **Points that are not collected are listed**,
with why beside them in plain words from `bas_points.inactive_reason` — five
values, closed by a CHECK, and a second CHECK that forces it NULL on any point
that is on. `Global_Alarm` reads as *alarm history* and never as a system log:
it is building data waiting for a table of its own. A NULL reads "reason not
recorded"; the platform never derives one from the name.
The list has the same kind of guard the tree has: `rendered` from the joined
query against `inDatabase` from a count with no joins, and a red banner when
they disagree. Nothing filters this list on `is_visible`, deliberately: a
hidden point has to be somewhere it can be shown again.

**Show/hide (B8.3, 18 September).** The *Shown* checkbox on that list is the
one editable thing on a point. It PATCHes `/settings/points/{id}` with
`{ visible }` - a schema with one field and no `isActive`, ever - writes
`is_visible` alone, and records `bas.point_visibility_changed` with
`collected: true` beside it. A hidden point leaves the Point Explorer picker
(a bookmark to one is told it is hidden, not gone) and the Collection Health
table, and **nothing else**: it stays in every risk figure, every
completeness count and the unfiltered comparison, and the screen says so with
the B7.6 sentence extended - *"No points at risk are listed in the table
below, but 1 hidden point is at risk."* Tested by hiding the only at-risk
point in a building and asserting the screen does not read as all clear;
adding `is_visible` to a risk `FILTER` fails it. `is_visible` is in none of
the six views; the service joins `bas_points` for it.

**A point the station stopped reporting is surfaced (18 September).** Found
while building B8.3: every figure on Collection Health was
`FILTER (WHERE is_active)`, so the collector marking a vanished history
`no_longer_reported` removed it from the at-risk count - a deleted trend made
the dashboard look better. Verified on live in a rolled-back transaction.
Now `pointsNoLongerReported` and `vanished` (name, station, last record) are
in the payload, rendered as an always-present card, amber from one, and
carried into the unfiltered comparison. Not in the at-risk hero: that tile is
about lagging a horizon, and this is about a history that is gone. The four
deliberate reasons stay out. `runbook.md` → *Collection Health says a point
is no longer reported by the station*.

### Filters

Time range (24 h / 7 d / 30 d) and a project → building → station cascade with
"All" at every level. Both live in the URL. Filtering happens in the `WHERE`
clause, and entitlement and selection are kept apart and intersected; a site
outside the entitlement returns 404, matching the module guard.

---

## Classification — the office building, in SQL

**This is the section the 8 September version said could not exist yet** —
"most fault rules need `equipment_id`, which nothing currently sets." On 17
September the office building was classified by hand, in SQL, in about thirty
minutes:

| | |
|---|---|
| Equipment | one `rtu`, `RV`, and ten `vav` children of it, `VAV-1` … `VAV-10`, with room numbers |
| Points attached | **all 26** active points have an `equipment_id` |
| Roles | **20 of 26** points carry one, across **11** distinct roles |
| Setpoint pairs | **two** resolve automatically through `bas_point_roles.setpoint_for` — duct static pressure, and supply air temperature |
| Command/status pairs | none — the command and status roles are not assigned |
| `bas_point_links` | empty. "Attached" means attached to equipment; nothing is linked point-to-point |

**Six points are deliberately unclassified**, by the same rule as `Temp1`–`Temp3`
on the lab station: `OperatingState`, `OperatingStateOR`, `OpState`,
`System_Enable`, `Unit Status` and `Unit_Status_Mode` are the station's own state
and mode enumerations, their codes are not decoded, and inventing a role would
make the AI answer confidently about something untrue. They read `unclassified`,
amber, on the Collection Health screen, and that is correct.

Four Niagara system logs and the dead halves of two reconfigured `_cfg0` pairs
are inactive. The point inventory itself — what each history is, what its
horizon measures, what was found in it — is `ProjectStatus.md` *(phb-bas)*, not
here.

**Thirty minutes for 26 points is the case for B8.** There is still no point
management in the UI: no way to set a role, create equipment, rename a point or
mark one inactive. Every one of those was SQL. `docs/B8_point_management_plan.md`
is the plan; its central decision — *collect everything, filter what you see*,
because `is_active` is permanent and a hidden point is not — was written from
doing this by hand. B8.1, the schema, is built: `bas_points.label` and
`bas_points.is_visible`, both defaulting to how every row behaves today, with
`test_point_management.py` *(phb-bas)* proving `discover` writes neither.
B8.2 reads them: the Points level of the Settings tree shows every point on a
station, read-only, uncollected ones included, with a counting guard of its
own. Editing is B8.3 onward.

---

## Security

**Five Postgres roles and two Niagara accounts, each scoped to what it needs.**

| Account | Where | Can |
|---|---|---|
| `bas_collector` (Niagara) | on each JACE | Read histories, `HTTPBasicScheme`. Cannot write to the station at all |
| `bas_collector` (Postgres) | platform database | Read/write `bas_*` only. Refused on `employees`, `audit_events`, `_prisma_migrations` — which is the refusal that broke the backup, below |
| `bas_readonly_platform` | platform database | SELECT on an **explicit allowlist** of `bas_*` objects, excluding the credentials table. Grafana and the MCP server |
| `bas_backup` | platform database | `pg_read_all_data` — reads every table, writes none — plus `CREATEDB` for the restore test's scratch database. **Added 17 September**, `setup_backup_role.sql` *(phb-bas)*, which proves its own grants before finishing |
| `bas_analyze` | platform database | SELECT on the **same explicit allowlist** as `bas_readonly_platform`, credentials table withheld. The Analyze tab's SQL and nothing else. **Added 21 September**, `npm run bas:analyze:role` *(this repo)*, which gates on unclassified `bas_*` objects and proves the refusals with read-only OFF before printing the URL. `TEMP` is deliberately not revoked — it is a `PUBLIC` grant and revoking it would change every role; the READ ONLY transaction refuses it instead |
| `postgres` | platform database | Superuser. Migrations and the developer's `.env.local`. **In no script and no scheduled task** |
| `bas`, `bas_readonly` | the retired standalone database | Rollback path only |

Every refusal was tested, not assumed. A grant that lets the right thing through
proves nothing on its own.

The read-only grants are an **explicit allowlist**, and the script that applies
them **refuses to run** when it meets a `bas_*` object it has not been told
about. The reason is `bas_station_credentials`: it matches `bas\_%`, and a
pattern-based grant would have handed Grafana the encrypted logins as a reward
for following the runbook. See `runbook.md` → *The read-only grant script will
hand out the credentials table*.

**Module access** uses the platform's own guard. `requireModuleAccess('bas')`,
404 rather than 403 for a missing grant. A test walks `app/api/modules/bas/**`
and fails any handler that skips the wrapper. **No Next.js layout wraps the
tabs**, so an ungranted employee does not get the module heading around a 404.

**Certificate pinning.** Each station's TLS fingerprint is recorded on its row
and the collector *(phb-bas)* verifies by fingerprint rather than by chain — a
JACE presents a self-signed certificate, so a chain check cannot succeed and
pinning is stricter than one would be. Both direct stations are pinned.

---

## Tooling

**In `phb-platform`:**

| Command | What |
|---|---|
| `npx tsx scripts/bas-import.ts` | Dry run — counts only, writes nothing |
| `… --apply` | Import. One transaction, verified before commit |
| `npx tsx scripts/bas-checksum.ts` | Content checksum of the `bas_*` tables |
| `npm run bas:verify` | Independent content comparison of two databases |
| `npm run bas:oracle` | Compares the screens against the Grafana dashboards' own SQL *(phb-bas)*, same moment |
| `npx tsx scripts/bas-tables.ts` | Table inspection |

**In `phb-bas`** — version controlled there, alongside the collector. Nothing in
`phb-platform` can exercise them:

| Command | What |
|---|---|
| `python -m collector check / discover / sync / status` | Connectivity; register a station's histories; one pass; health |
| `python healthcheck.py` | Collection, outages already recovered, completeness, cadence, station clocks, **backup freshness**, and its own schema |
| `Backup-BasDatabase.ps1` | Nightly dump as `bas_backup`, verified, marked, rotated |
| `Test-BasRestore.ps1` | Restores the newest verified dump to a scratch database and compares ten tables |
| `setup_backup_role.sql` | Creates `bas_backup` and proves what it can and cannot do |
| `test_completeness.py`, `test_targets.py`, `test_discover.py`, `test_healthcheck_outage.py`, `test_backup.py`, `verify_chain.py` | 124 / 83 / 71 / 145 / 41 / 40 on 17 September. Each but the last builds its own throwaway PostgreSQL cluster and never opens the live database |

**Verification is by content, not row counts.** The import once reported
"12/12 tables reconciled, 3,481 rows" and was wrong: every timestamp had lost its
microseconds and a JSON array had become an object.

---

## Constraints that are not bugs

### `bas_readings.status` is always NULL

Niagara does not send status with history records over oBIX. The response's
`#RecordDef` declares exactly two fields, timestamp and value. **NULL means "not
supplied", never "no fault."** Fault detection here is value-based only, which
is portable: a rule saying −40 °F is not a room temperature works on Johnson
Controls and Siemens too.

### The lab data is synthetic; the office data is real

Four active points on the lab station. `Temp1`–`Temp3` are History Emulator
output and nobody knows what they represent, so they are deliberately left
unclassified. `points_RoomT` is a real sensor. That station is **not PH+B's
asset**: its licence belongs to Building Controls & Solutions.

PHBoffice is real, PH+B's own, and holds history back to 21 February 2024 for
its change-of-value points. Its clock is 22 minutes ahead of the collector host
(below), so **every timestamp stored for it is stamped in its own time**, and
that is not corrected in the data because a corrected value is one nobody
measured.

### Irreplaceability

Past the roll horizon, the platform database is **the only copy of that data in
existence**. No re-import, no vendor archive, no station-side backup. For the
office that horizon is about five days for most points and about **two hours**
for its cycling status points; for the lab, 41.6 hours.

Three consequences, none optional: backups are a correctness requirement rather
than hygiene — and *The backup incident* below is what it looks like when that
requirement is met on paper and not in fact; anything reading BAS data for
analysis connects as a role with no write permission; and `--truncate-target`
or any manual `DELETE` needs a **verified** backup first.

### Azure

The container app may be scaled to zero freely. **The PostgreSQL server must not
be stopped.** A stopped database means the collector cannot write, and anything
past the roll horizon is destroyed at the station while nothing is reading.
Overnight is survivable. **A weekend is not, and that is measured**: five
stretches of collector silence are recorded in `bas_ingest_runs` — 64.3 h,
64.5 h, 137.8 h, 64.3 h, and one more of 16 h that cost nothing — and every one
past 41.6 hours destroyed data. In all of them it was the collector host that
stopped rather than the database, but the arithmetic does not care which end of
the seam fails. See *Proven in operation*.

---

## Proven in operation

**A real sensor fault, caught from the data — the lab, 24 August.** `points_RoomT`
stepped from ~73 °F to exactly −40 at 09:05 and held there. −40 is identical in
Celsius and Fahrenheit and is a common open-circuit signature. Confirmed in
Workbench, whose chart shows the same step at 13:00 UTC — which also
cross-checks our timestamps. Nothing told us; the station sends no status. It was
found because −40 is not a temperature.

**A dead sensor in a real building, found by the first question asked — the
office, 17 September.** VAV-8 (rooms 104–105) has read **exactly 70.5 °F for
every one of its 580 readings** — one distinct value across the whole span the
station holds. Every other zone moves, by 1.1 to 7.4 °F. No fault rule was
needed: the Point Explorer's distinct-values tile is the test. Whether the
rooftop unit's status point, which steps between three states every ~12 seconds
and so gives its 500-record buffer a two-to-five-hour horizon, means the machine
is short-cycling or the point is chattering **is not established**, and neither
document says otherwise. Both findings are written up with the numbers in
`ProjectStatus.md` *(phb-bas)*.

**Zero records, reported ok — the office's first sync, 16 September.** The run
said *28/28 points ok, 9,784 records*. Read live the next day: three points held
**nothing** (`Occupied`, 419 on the station; `System_Enable`, 317;
`OccupancyCommand`, 71) and three held two records of about 300 — **about 1,700
records across six points**. The collector's first-sync window was 30 days and
those change-of-value histories had last changed 35 days earlier; every request
came back empty, and an empty pass was a successful pass. Against the lab's
42-hour buffers the same window had always looked like "took everything". Nothing
was destroyed — the station still held it all — but nothing in the pipeline could
have said so, and a customer Supervisor would have imported a week of years. The
collector now starts at the station's own oldest record, and **every pass
compares the station's reported count with what the platform holds**. The verdict
is on `bas_sync_checkpoints.completeness` *(this repo)*, computed in
`collector/sync.py` *(phb-bas)*, and read by the screen, the view and the health
check. `runbook.md` → *A BAS run says `ok` and a point holds nothing*.

**The check's first live result was a false positive, and the cause was the
JACE's clock — the same day.** Two chattering points read `incomplete` by 70
records and a re-fetch could not close it. `/obix/about` on PHBoffice reported
11:00:38 against a host at 10:38:21; the lab station agreed with the host to
0.2 s. The collector's query was bounded at the host's `now`, so every record
the station had written in the last 22 minutes sat in the host's future. The
query has no upper bound now; the offset is measured every pass and recorded on
`bas_stations.clock_offset_s`; the health check reports it at WARNING; fixing the
clock is a station change and is **open**. `runbook.md` → *A BAS station's clock
is wrong*.

### Real data loss, recorded honestly — five outages

Read from `bas_ingest_runs` and `bas_data_gaps` on 17 September, and identical to
the table in `ProjectStatus.md` *(phb-bas)*. A silence longer than the lab
station's 41.6-hour buffer destroys data; the ~16-hour silence every weeknight
does not, and there are nineteen of those.

| Collection silent | For | Failed runs inside | Destroyed per point | Recorded |
|---|---|---|---|---|
| Thu 20 Aug 16:06 → Fri 21 Aug 08:06 | 16.0 h | 0 | nothing | — |
| Fri 21 Aug 16:05 → Mon 24 Aug 08:20 | 64.3 h | 0 | **22.6 h** | 24 Aug |
| Fri 28 Aug 15:50 → Mon 31 Aug 08:20 | 64.5 h | 0 | **22.8 h** | 31 Aug — and unread for eight days |
| Thu 3 Sep 16:20 → Wed 9 Sep 10:11 | **137.8 h** | 10 | **96.2 h** | 8 Sep as 71.7 h, then 9 Sep as 96.2 h |
| Fri 11 Sep 16:05 → Mon 14 Sep 08:20 | 64.3 h | 0 | **22.6 h** | 14 Sep |

**Five outages, four destroying data, about 164 hours per point.** Two
corrections to the 8 September version of this document, which said three
outages and 117 hours:

- **The 11–14 September weekend was missing.** Same shape as the two August
  weekends, same loss, detected on the Monday, and in no document until now.
- **The September outage was longer and cost more than recorded.** Collection was
  silent 137.8 hours to the first *successful* run, not 113.4 to the first
  attempt; the ten failed runs inside it are the host firing from the wrong
  network. The gap was recorded twice — 71.7 h on 8 September, 96.2 h on 9
  September as the station's window moved on — and there is **no lab reading
  between 6 Sep 16:04 and 7 Sep 16:31**, so the loss is the larger figure. The
  duplicate rows are a wart of the old inferred gap detector; it now uses the
  station's own oldest record and cannot record one loss twice.

The arithmetic is the roll horizon: silence minus the buffer is what the station
overwrote before we read it. Collection resumed on 9 September and again on 14
September; the newest lab reading is current.

### Two causes, not one

1. **The laptop sleeps** — no collection. The scheduled task never fires because
   the machine is not awake. The whole of the weekend pattern.
2. **Mahi works from home** — no collection *even with the laptop awake*, because
   the JACEs are on the building network and there is no VPN. The scheduled task
   fires perfectly, writes a failed run every fifteen minutes, and collects
   nothing. The ten failed runs inside the September outage are this.

**So the availability requirement is not "a machine that stays on". It is a
machine that stays on and never leaves the building network.** A host awake in
the wrong place looks healthy in every tile.

### Recording a failure is not the same as noticing it

**The 28–31 August outage sat in `bas_data_gaps` for eight days without appearing
in a single document**, while five commits edited `runbook.md` and `CLAUDE.md`.
The gap-recording machinery worked perfectly. Reading it was the weak link, and
the tiles go green the moment collection resumes. That is why `healthcheck.py`
*(phb-bas)* check 1b reports outages that have **already recovered**, since those
are precisely the ones nothing else will mention again.

It happened twice more in September, in smaller ways, and the pattern is the
lesson: the completeness check wrote `incomplete` to a column for a day before
anything read it, and — the large one — the backup failed for three weeks while
the health check watched collection and nothing else.

### The backup incident

**The nightly backup never once succeeded against the platform database.** The
first attempt after the 24 August cutover was on 28 August; it and every attempt
until 17 September died before writing a byte:

```
pg_dump: error: query failed: ERROR:  permission denied for table _prisma_migrations
FAILED: pg_dump exited 1
```

The last verified dump was `bas_2026-08-24_1126.dump`, of the standalone
database retired that day — and no platform dump was ever written before 17
September: no attempt at all was made on 25, 26 or 27 August (the task did not
fire; why is unestablished, Task Scheduler's history begins on 9 September), and
the directory listing taken on 17 September before rotation held nothing dated
between the 24th and the 28th. Three 0-byte `.dump` files sat in OneDrive looking
like backups in a directory listing. The scheduled task showed `LastTaskResult 1`
and stopped firing on 14 September. For those three weeks the 42,000 readings in
the platform database — including the office's history to February 2024, which
the JACE no longer holds — existed in exactly one place.

**Cause: one environment variable serving two jobs with opposite privilege
needs.** `Backup-BasDatabase.ps1` read the collector's `DATABASE_URL` from the
same `.env`. The B6 cutover (`abcacf3` *(phb-bas)*, 24 August) pointed that at
the platform database as the `postgres` superuser, which a dump can use; then,
between 24 August 11:26 and 28 August 08:29, the connection was moved to the
least-privilege `bas_collector` role — correctly, the collector must not be able
to read `employees`, and the role existed by 12:44 on the 24th — but the exact
moment is in no tracked file, because `.env` is not in git. `pg_dump` of a whole
database as that role fails on the first table it cannot lock. Tightening one job
broke the other, silently, at a distance, days later. (An earlier version of this
section blamed B7.5, which shipped on 9 September, sixteen days after the first
failure, and did not touch `DATABASE_URL`.) **Nobody noticed for three weeks
because nothing watched it.** The health check watched collection; the one thing
protecting the data once collected had no monitoring at all.

This is the clearest example in the project of a shared setting coupling two
things with opposite needs, and it is the reason *The database is the seam*
above now says the seam is also where a shared setting couples them without
anyone noticing.

**What changed, 17 September** *(phb-bas, `fix/backup-role-and-monitoring`)*:

- A `bas_backup` role: `pg_read_all_data`, the documented way to let a
  non-superuser take a complete dump, plus `CREATEDB` for the restore test's
  scratch database. Reads everything, writes nothing. Its own connection string,
  `BAS_BACKUP_URL`. Both scripts refuse to run without it and refuse
  `bas_collector` by name, rather than falling back.
- A verified dump gets a `.verified` marker beside it; a failed attempt's partial
  file is deleted; rotation removes empties.
- **`healthcheck.py` reads the dump directory** — the files and their markers, not
  the task's exit code. No verified dump in 48 hours is CRITICAL, the same
  severity as records being overwritten at the station, because it is the same
  class of loss. It runs even when the database is unreachable.
- The health check also guards its own schema: on 17 September it ran between two
  platform migrations and died with a traceback on a missing column, reporting
  nothing. A schema that is behind is now a CRITICAL finding; the other checks
  still report.
- Proven the failure first, then the fix: `test_backup.py` *(phb-bas)* runs the
  real scripts against a throwaway cluster carrying this repository's migrations;
  the wrong role fails loudly and the health check goes CRITICAL; `bas_backup`
  dumps, the restore test says `RESTORE VERIFIED`, and ageing the marker past
  48 hours turns the check CRITICAL.

Live at 12:21 on 17 September: a 0.49 MB dump verified with 254 archive entries,
the restore test matched all ten tables (42,652 readings), the health check read
`[OK] Newest verified backup is 0.0 h old`. Rotation also removed the three
August dumps of the retired standalone database, which were past the 14-day
retention, so the last verified dump from before that day **no longer exists on
disk**; the standalone database itself is still on the server with 5,615
readings to 24 August 10:35, every one of which the platform also holds. The
recovery table in `runbook.md` → *Repointing the collector also repoints the
nightly backup* says where to look and where not to bother; `RUNBOOK.md`
*(phb-bas)* → *Health check says NO VERIFIED BACKUP EXISTS* is the procedure.

---

## What was checked, and where

**Confirmed on 2026-09-17** against the files, the live database and the live
stations:

| Claim | Checked |
|---|---|
| 14 `bas_*` tables | `@@map("bas_*")` in `prisma/schema.prisma` — 14 |
| 6 views, all `bas_v_` prefixed | `information_schema.views` — 6 |
| 20 CHECK constraints, 3 triggers | `pg_constraint`, `pg_trigger` on the live database |
| 17 migrations applied | `_prisma_migrations`; the last five dated 17 September. `add_bas_comments` appears twice there — a rolled-back attempt and the successful re-application a minute later — and that is correct |
| Three tabs, and B5 not among them | `app/(modules)/bas/tabs.ts` lists three; its comment says where B5's line would go |
| Credentials never returned | the settings query selects `cred.username` and `cred.updated_at` and says why the ciphertext is not there |
| Every settings write audited | `audit_events`: `bas.project_created`, `bas.building_created`, `bas.station_created`, `bas.credential_set`, and their updates and deletes, each with an actor |
| Two direct stations, one via-parent placeholder | `bas_stations`, with addresses, versions, pins and clock offsets |
| 26 of 32 office histories active, 20 classified, 11 roles, 11 equipment, 2 setpoint pairs, `bas_point_links` empty | `bas_points`, `bas_equipment`, `bas_v_setpoint_pair`, `bas_point_links` |
| 42,652 readings; five silences; the gap rows | `bas_readings`, `bas_ingest_runs`, `bas_data_gaps` |
| The backup's three weeks of failure | `logs\backup.log` *(phb-bas)* and the 0-byte files, before they were rotated |
| The clock offset | `/obix/about` on both stations against the host, at the request midpoint |

**Checkable in `phb-bas`, not here:** the collector's behaviour on a pass, the
health check's findings, the backup and restore scripts, the six test suites.
**Checkable in neither** and taken from the people who did them: how oBIX was
enabled on the office JACE (reported as needing only an `ObixNetwork` component
and a read-only user, with no firmware upgrade — nothing in either repository
records it), and why each collector outage happened.

---

## Not built

**B5 — asking questions in plain English.** Eight tools, a guarded SQL escape
hatch on its own read-only connection, an audit event per question. Designed, not
started, **not a tab**. Blocked on a company Anthropic API key. It would live in
`phb-platform`, and it is what supersedes `bas-mcp` *(phb-bas)* when it ships.

**B8 — point management.** Designed 17 September; B8.1, the schema, and B8.2,
the read-only Points list, built the same day; B8.3, show/hide with the risk
rule, on 18 September; B8.4 onward not started:
`docs/B8_point_management_plan.md`. There is no way in the UI to set a role,
create equipment, attach a point, rename one or mark one inactive; the office
was classified in SQL and the six state points wait for someone to decode them
the same way. Thirty minutes for 26 points; a project with ten JACEs would take
a week and nobody would do it.

**Production deployment.** Firewall rule for the site's egress IP, a scoped role
on the Azure database, and an always-on host **that stays on the building
network**. Five outages say the laptop is not that host. Blocked on the Azure
subscription and the host.

**Multiple buildings, the way they were planned.** The 20 August plan was one
central station importing other JACEs' histories over the NiagaraNetwork, so
that no production JACE needed a firmware upgrade. **The office was connected
directly instead** — on 4.10 it needed no upgrade — and `via_parent` stations
have never been exercised; whether imported histories keep their source
station's name under `/obix/histories/` is still unobserved. The schema and the
filters support both routes.

**Fixing the office JACE's clock, and decoding its six state codes.** Both are
station-side or engineering work, both open, and the second is what stands
between "the status point cycles every 12 seconds" and a verdict on the machine.

---

## The open dependencies

Not one any more. **An always-on host on the building network**, so the five
outages stop at five. **A backup that stays watched**: the mechanism is fixed and
monitored as of today, and the first nightly run under it has not yet happened.
**An API key** for B5. And **B8**, before the next building is classified by
hand.
