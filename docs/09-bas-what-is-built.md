# BAS module — what is built

A record of the Building Automation module as it stands. Companion to
`08-bas-and-niagara.md`, which explains *why* it is shaped this way; this one
says *what exists*.

Failure modes are in `runbook.md` under *BAS — Building Automation module*.

**Last updated:** 28 August 2026 — checked against the repository and corrected.
The prose was written from session reports; every claim below that the repo can
settle has now been settled against it. Corrections are noted where they matter
rather than silently applied.

---

## In one paragraph

A building controller keeps roughly 42 hours of sensor history and then
overwrites it silently. A small Python collector reads that history out over
oBIX every 15 minutes and writes it into the platform's PostgreSQL database,
where it is kept permanently. Two dashboards inside the platform read that data.
Nothing is installed on the controller, and the account used to read it cannot
write anything back.

---

## The pieces

| Piece | Where it lives | What it does |
|---|---|---|
| **JACE** | the building, `196.1.1.213` | Runs the equipment. Logs each point every 5 min, keeps ~42 h |
| **`bas_collector` Niagara account** | on the station | Read-only. The only thing added to the JACE |
| **Collector** | `C:\dev\bas-collector`, repo `phb-bas` | Python. Reads oBIX every 15 min, writes to Postgres |
| **`bas_*` tables** | platform database | 12 tables, 6 views. Permanent |
| **Building Automation module** | `phb-platform` | Two tabbed dashboards behind the platform's own login and grants |
| **Grafana** | `localhost:3001` | Second view onto the same data. Development and verification tool, not a deliverable |
| **`bas-mcp`** | `C:\dev\bas-mcp` | Lets Claude Desktop query the data. Superseded by B5 when that ships |
| **Nightly backup** | 02:15, to OneDrive | Load-bearing — see *Irreplaceability* |

**Two deployables, and the database is the seam.** The collector knows Niagara
and nothing about the platform. The platform knows the schema and nothing about
Niagara. Neither can break the other except through the database.

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
| **Cutover** | Collector retargeted at the platform database, Grafana and MCP repointed | **not in this repo** — see below |
| **B4** | Point Explorer, tabbed layout | `e76eba4` (2026-08-24) |

Four later BAS commits the earlier version of this table omitted, all 2026-08-24:

| What | Commit |
|---|---|
| B6 blocked: the collector cannot write to the platform schema | `367388c` |
| Runbook: the BAS read-only role on the platform database | `c72bd00` |
| The Azure uptime constraint — never stop the database | `a59f1fd` |
| Correct what `bas_readings.status` means | `694fe10` |

### Corrections to the commit column

- **`367388c` was attributed to content verification. It is not that commit.**
  `367388c` is *"B6 is blocked: the collector cannot write to the platform
  schema"*. All three verification scripts — `bas-checksum.ts`,
  `bas-verify-import.ts`, `bas-health-oracle.ts` — were added by `278b723`,
  the B3 commit.
- **`abcacf3` and `78776fd` do not exist in `phb-platform`.** `git log` does not
  resolve either. The cutover retargeted the *collector*, Grafana and the MCP
  server, none of which live in this repository, so those hashes are most likely
  from `phb-bas`. They are left unresolved here rather than guessed at; if the
  cutover needs a citation, it belongs in the collector repo's history.

### Test count

**911 tests, measured 2026-08-28** on the current `main`, of which roughly 280 are
BAS tests.

**The previously recorded "710, from a 416 baseline" is unverified**, not
disproved. Establishing it would mean checking out `e76eba4`, rebuilding the test
database against that commit's migration set, and running the suite — which
would leave the shared test database on an older schema. A `grep` proxy over
`tests/` gives 605 test declarations at `e76eba4` against 750 at HEAD, but the
proxy undercounts (750 against a true 911) because tests generated in loops are
invisible to it, so it cannot settle the question either way.

The number that matters for a *what is built* document is the current one, and
that is measured.

---

## The database

Twelve tables under `public` with a `bas_` prefix, managed by Prisma.

```
bas_orgs
 └── bas_sites                     a building
      └── bas_stations             a JACE (or a Supervisor)
           └── bas_points          one trended value
                └── bas_readings   the numbers
      └── bas_equipment            AHU-3, VAV-204
```

Plus `bas_point_roles` and `bas_equipment_types` (controlled vocabularies, 91 and
25 rows, seeded), `bas_point_links`, and three operational tables —
`bas_sync_checkpoints`, `bas_ingest_runs`, `bas_data_gaps`.

Six views, all prefixed `bas_v_`. That prefix is **load-bearing**:
`bas_v_data_dictionary` selects objects matching `bas\_%`, so an unprefixed view
would be invisible to it and therefore invisible to the AI.

### Four invariants

**Point identity is a surrogate key, never a name.** A point renamed in Niagara
becomes a new row rather than silently reinterpreting years of history.

**Every timestamp is UTC.** Local time is display only. There is no way to unwind
a DST bug afterwards.

**`bas_readings` carries no names, units or equipment.** Denormalising those
multiplies storage roughly 5× and turns a rename into a billion-row rewrite.

**History names are stored exactly as Niagara returns them**, `$`-hex escapes
included. That string goes into the oBIX URL verbatim.

### `roll_horizon_s` is maintained by a trigger

Not a generated column. Prisma reads `GENERATED ALWAYS AS` as a default it cannot
express and proposes an `ALTER … DROP DEFAULT` that PostgreSQL rejects on a
generated column — which permanently blocks every later migration. Prisma ignores
triggers, so a trigger keeps the value correct and the schema diff empty.

**`schema.prisma` is not the whole schema.** The trigger, 13 CHECK constraints
and the six views live in the migration SQL. Prisma models columns and indexes;
it ignores constraints and triggers.

---

## The screens

One module, two tabs — real routes, not client-side state, so each is
bookmarkable and each guards itself independently.

### Collection Health — `/bas`

Five tiles: active points, total readings, unclassified points, points at risk of
data loss, time since the newest reading. A per-point status table. Records
written per collector run. Recent collector runs. Recorded data gaps.

**Two tiles have semantics that must not drift.** *Points at risk* counts
`data_lost` — the station overwrote records before we collected them, gone
permanently — and `roll_horizon_unknown`, meaning capacity has not been filled in
from Workbench so we cannot tell. **Unknown is not safe and must never render
green.** *Unclassified points* is amber by design: a point with no role is
invisible to role-based questions, which is a backlog item rather than a fault.

### Point Explorer — `/bas/points`

Point picker, trend chart, and tiles for latest, average, range, readings versus
null records, and distinct values.

**Distinct values, not standard deviation**, for judging whether a sensor is
alive. A standard-deviation threshold is unit-dependent and untunable across
buildings — it missed a sensor frozen at 64.5 with σ = 0.08. Distinct-value count
is unit-independent.

**The chart breaks across gaps rather than interpolating.** A line drawn straight
through a hole asserts readings that never existed and in fact were destroyed.
Three mechanisms, because a break alone reads as a rendering artifact: an
inserted null with `connectNulls={false}`, a shaded band, and a written list of
gaps beneath the chart.

**One point at a time**, matching Grafana. That avoids overlaying °F and °C on
one axis. Where a point has no unit recorded the axis says so rather than going
bare — bare reads as "none needed," and the truth is "unknown."

### Filters

Time range (24 h / 7 d / 30 d) and a building dropdown with "All". Both live in
the URL, so they survive a refresh, a bookmark, and a tab switch.

Filtering happens in the `WHERE` clause, not by fetching everything and hiding
rows. With one building those look identical; at ten they do not.

Entitlement and selection are kept apart: which sites an employee *may* see is
separate from which they *asked for*, the two are intersected, and every query is
built from the intersection. A site outside the entitlement returns 404, matching
the module guard — "exists but not yours" must not be distinguishable from
"doesn't exist."

---

## Security

**Three separate accounts, each scoped to what it needs.**

| Account | Where | Can |
|---|---|---|
| `bas_collector` (Niagara) | on the JACE | Read histories. Cannot write to the station at all |
| `bas_collector` (Postgres) | platform database | Read/write `bas_*` only. Refused on `employees`, `audit_events` |
| `bas_readonly_platform` | platform database | SELECT on `bas_*` only. Used by Grafana and the MCP server |

Every refusal was tested, not assumed. A grant that lets the right thing through
proves nothing on its own.

The Postgres grants are **table-by-table**, deliberately not
`ALTER DEFAULT PRIVILEGES` — that cannot be filtered by name and would grant
access to whatever table Prisma creates next. The cost is that a new `bas_*`
table is invisible until granted, which fails loudly rather than silently.

**Module access** uses the platform's own guard. `requireModuleAccess('bas')`,
404 rather than 403 for a missing grant, grants read from the database on every
request. A test walks `app/api/modules/bas/**` and fails any handler that skips
the wrapper.

**No Next.js layout wraps the tabs.** A layout renders around a page that calls
`notFound()`, so an ungranted employee would get the module heading and tab bar
wrapped around a 404 — confirming the module exists to exactly the person it is
hidden from.

---

## Tooling

**In `phb-platform`** — these exist and were checked:

| Command | What |
|---|---|
| `npx tsx scripts/bas-import.ts` | Dry run — counts only, writes nothing |
| `… --apply` | Import. One transaction, verified before commit |
| `npx tsx scripts/bas-checksum.ts` | Content checksum of the `bas_*` tables |
| `npm run bas:verify` | Independent content comparison of two databases |
| `npm run bas:oracle` | Compares the screens against Grafana's own SQL, same moment |
| `npx tsx scripts/bas-tables.ts` | Table inspection |

**Elsewhere** — real, but not in this repository, so nothing here can confirm
their behaviour:

| Command | Where | What |
|---|---|---|
| `python -m collector check` | `phb-bas` | Connectivity and configuration |
| `python -m collector status` | `phb-bas` | Points, readings, risk, recent runs |
| `Backup-BasDatabase.ps1` | not in `phb-platform` | Nightly dump, verified and rotated |
| `Test-BasRestore.ps1` | not in `phb-platform` | Restores to a scratch database and compares |

### Corrections to the tooling table

- **There is no `bas:checksum` npm script.** The earlier version listed one.
  `package.json` defines exactly two BAS scripts, `bas:verify` and `bas:oracle`.
  `scripts/bas-checksum.ts` does exist and is real — it simply has no alias, and
  is run with `npx tsx`.
- **`Backup-BasDatabase.ps1` and `Test-BasRestore.ps1` are not in this
  repository** — not tracked by git and not present on disk. They are presumably
  on the collector machine or in `phb-bas`. The earlier version listed them
  beside the repo commands without distinction, which read as though
  `npm test` covers them. It does not, and neither does anything else here.
  **Given that backups are called a correctness requirement under
  *Irreplaceability*, a backup script no repository owns is worth someone's
  attention rather than a table row.**

**Verification is by content, not row counts.** The import once reported
"12/12 tables reconciled, 3,481 rows" and was wrong: every timestamp had lost its
microseconds and a JSON array had become an object. Counts confirm a row exists,
not that it is the same row.

---

## Constraints that are not bugs

### `bas_readings.status` is always NULL

Niagara does not send status with history records over oBIX. The response's
`#RecordDef` declares exactly two fields, timestamp and value. The collector is
not dropping anything.

**NULL means "not supplied", never "no fault."** Fault detection here is
value-based only — we cannot ask what the station believes about a reading.

That is workable and arguably better: a rule saying a room temperature of −40 °F
is not a temperature works on Johnson Controls and Siemens too.

### The data is synthetic

Four active points on the lab station. `Temp1`–`Temp3` are History Emulator
output and nobody knows what they represent, so they are deliberately left
unclassified — inventing a role would make the AI answer confidently about
something untrue. `points_RoomT` is a real sensor.

That station is also **not PH+B's asset**. Its licence belongs to Building
Controls & Solutions under a Columbus Temperature Controls project.

### Irreplaceability

Past the roll horizon, the platform database is **the only copy of that data in
existence**. No re-import, no vendor archive, no station-side backup.

Three consequences, none optional: backups are a correctness requirement rather
than hygiene; anything reading BAS data for analysis connects as a role with no
write permission; and `--truncate-target` or any manual `DELETE` needs a verified
backup first.

### Azure

The container app may be scaled to zero freely. **The PostgreSQL server must not
be stopped.** A stopped database means the collector cannot write, and anything
past ~42 hours is destroyed at the station while nothing is reading. Overnight is
survivable. A weekend — about 61 hours — is not.

---

## Proven in operation

**A real sensor fault, caught from the data.** `points_RoomT` stepped from ~73 °F
to exactly −40 at 09:05 on 24 August and held there. −40 is identical in Celsius
and Fahrenheit and is a common open-circuit signature. Confirmed independently in
Workbench, whose chart shows the same vertical step at 13:00 UTC — which also
cross-checks our timestamps, since 13:05 UTC is 09:05 EDT.

Nothing told us. The station sends no status. It was found because −40 is not a
temperature.

**A real data loss, recorded honestly.** The collector was silent for 64.3 hours
over the weekend of 21–24 August because the laptop was closed. Against a
41.7-hour buffer that destroyed **22.6 hours per point**, recorded as
`roll_overwrite` gaps and visible on the Collection Health screen.

The system did not pretend otherwise. That is the behaviour that matters — a gap
recorded is a gap analysis can account for.

---

## What was checked against the repository

Everything in this section was verified on 2026-08-28 against the files, not
against a session report.

**Confirmed exactly as described:**

| Claim | Checked |
|---|---|
| 12 `bas_*` tables | `CREATE TABLE` in `prisma/migrations/` — 12, names as listed |
| 6 views, all `bas_v_` prefixed | 6: `collection_health`, `command_status_pair`, `data_dictionary`, `point`, `reading`, `setpoint_pair` |
| `bas_v_data_dictionary` matches `bas\_%` | present in the migration SQL |
| 13 CHECK constraints in migration SQL | 13 |
| `roll_horizon_s` kept by a trigger, not a generated column | present, with the Prisma reasoning in the SQL comments |
| 91 point roles, 25 equipment types | `tests/bas-vocabularies.test.ts` asserts both |
| Two tabs at `/bas` and `/bas/points` | both routes exist |
| No Next.js layout wraps the tabs | there is no `app/(modules)/bas/layout.tsx` |
| A test walks `app/api/modules/bas/**` for the guard | `tests/bas-module.test.ts` — it fails any handler containing `requireModuleAccess(` or missing `withBas` |
| `withBas` exists | `lib/modules/bas/route-helpers.ts` |
| Chart breaks across gaps with `connectNulls={false}` | `app/(modules)/bas/point-explorer.tsx` |
| `postinstall` forces `prisma generate` | `package.json` |

**Not checkable from this repository**, and therefore taken on trust rather than
verified: the JACE and its address, the Niagara `bas_collector` account, the
collector at `C:\dev\bas-collector`, `bas-mcp`, Grafana on `localhost:3001`, the
nightly backup at 02:15, the two PowerShell scripts, the Postgres roles and their
grants, the synthetic-data claims, the sensor fault of 24 August and the 64.3-hour
collector outage. All of those are about systems outside `phb-platform`.

That split is the useful part: roughly half of this document describes things no
test in this repository can hold to account.

---

## Not built

**B5 — asking questions in plain English.** Eight tools, a guarded SQL escape
hatch on its own read-only connection, an audit event per question. Designed, not
started. Blocked on a company Anthropic API key.

**Point classification tooling.** Bulk role assignment, equipment creation and
linking. Deliberately deferred — the right shape depends on how a given
building's integrator named things, and most fault rules need `equipment_id`,
which nothing currently sets.

**Production deployment.** Firewall rule for the site's egress IP, a scoped role
on the Azure database, and an always-on host. Blocked on the Azure subscription.

**Multiple buildings.** The schema supports it throughout and the filters are
already built for it. The plan is one central station importing other JACEs'
histories over the NiagaraNetwork, so no production JACE needs a firmware
upgrade. The lab station caps at 1,250 points and 26 devices — realistically two
or three buildings — beyond which a Niagara Supervisor is a purchase decision
nobody has owned yet.

---

## The open dependency

**Access to a production JACE.** Everything above runs against four synthetic
points. The question that matters is not the IP address — it is whether history
extensions are configured on that station at all. If nobody ever set them up,
this becomes a Niagara engineering job before it is a data job.
