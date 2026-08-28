# BAS — building automation data

What the module is, why it is shaped the way it is, and how to build it.

Read this before touching anything under `bas_*`, `lib/modules/bas`, or
`scripts/bas-import.ts`. Operational failure modes are in `runbook.md`
under *BAS — Building Automation module*.

---

## What this module is for

A commercial building is a machine with a few hundred to a few thousand sensors
on it. The control system reads them every few seconds, decides, acts, and
repeats — forever. It is very good at that.

It is very bad at remembering. A controller keeps roughly **two days** of
history and then overwrites it, silently. Nobody can ask it what happened last
March, compare this air handler to the one on the floor below, or notice that a
valve has been slowly failing since April.

The module's purpose is to get that data somewhere it can be kept, compared,
and questioned — and then to let an employee ask questions of it in English
rather than SQL.

Concretely, two screens and an answer box:

- **Collection Health** — is data arriving, and is any of it about to be lost
- **Point Explorer** — what did this sensor do, over this window
- **Ask** — "why did zone 4 overheat on Tuesday", answered from the data

## Vocabulary

Enough to read the rest of this document. The building trade uses these words
constantly and none of them are guessable.

| Term | Meaning |
|---|---|
| **BAS** | Building Automation System. The control system for a building's mechanical equipment |
| **Point** | One named, addressable value. `AHU-3/SupplyAirTemp` = 54.2 °F |
| **AHU** | Air Handling Unit — conditions and moves air for a floor or zone |
| **VAV** | Variable Air Volume box — regulates airflow into one zone |
| **Setpoint** | The target a control loop is chasing. Distinct from the measurement |
| **Trend / History** | A logged time series of one point |
| **Niagara** | Tridium's building-automation *framework*. Not a product |
| **Station** | A running Niagara application instance |
| **JACE** | The embedded controller that runs a station. Java Application Control Engine |
| **Supervisor** | A server-class Niagara station aggregating several JACEs. We do not have one |
| **oBIX** | Open Building Information Exchange. An OASIS XML standard. How we read the data |
| **Roll horizon** | `capacity × collection_interval` — how far back a history reaches before the station overwrites it |

**The distinction that drives most analysis** is *command* vs *status* vs
*setpoint* vs *measurement*. "The fan is commanded on" and "the fan is actually
running" are two different points, and the gap between them is a fault.
"Setpoint is 55" and "temperature is 62" is another. Nearly every useful
statement about a building comes from comparing points that ought to agree.

## The three numbers that determine everything

Every Niagara history has three settings:

| | |
|---|---|
| **Collection interval** | how often a record is written |
| **Capacity** | how many records are kept |
| **Full policy** | at capacity — `Roll` (overwrite oldest) or `Stop` |

Niagara's default is **capacity 500, policy Roll**. Multiply it out:

| Interval | 500 records covers |
|---|---|
| 1 minute | 8.3 hours |
| 5 minutes | **1.7 days** |
| 15 minutes | 5.2 days |
| 1 hour | 20.8 days |

Past that the station overwrites. **No alarm, no log entry, no gap marker.** If
collection stops for longer than the roll horizon, data is destroyed
permanently and nothing anywhere says so.

Measured on the lab station: 500 records at 300 seconds = **41.7 hours**.

This single fact explains most of the design. It is why the collector polls
every 15 minutes rather than nightly, why it refuses to start when the margin is
too thin, why gaps are recorded explicitly, and why the backup requirement is a
correctness requirement rather than hygiene.

## Why we copy the data, when `docs/05` says not to

`docs/05-database-and-sources.md` is unambiguous: *if the platform is not the
authoritative owner of some information, do not store it.* For Change Orders
that is right — Exchange keeps the mailbox, so a local copy is a second source
of truth and therefore a bug.

**Niagara is not a system of record.** It is a rolling buffer sized for about
two days. Stated precisely:

> The JACE is authoritative for current state, and for the last N hours of
> history where N is the measured roll horizon. **Beyond N, nothing is
> authoritative — the data has ceased to exist.**

So storing history is not duplicating an owner. It is becoming the first one.
`docs/05` anticipates this case and asks for the argument to be made explicitly
rather than assumed. This is that argument.

**Three consequences, none optional:**

1. **Backups are load-bearing.** Change Orders can lose its database and rebuild
   from Exchange. This cannot. A restore must be *tested*, not assumed.
2. **It goes in the runbook in bold.** Nothing about the code tells you these
   rows are irreplaceable.
3. **The override covers history only.** Current values, point configuration and
   station metadata remain owned by the JACE and are re-derived on discovery,
   never treated as truth.

---

## Shape

Two deployables. The database is the seam.

```
┌─ building network ─────────────────────────────┐
│                                                │
│   JACE — Niagara 4 station                     │
│   · ~42h rolling history buffer                │
│   · oBIX servlet over HTTPS                    │
│   · read-only service account                  │
│         ▲                                      │
│         │ GET ~historyQuery?start=&end=&limit= │
│         │                                      │
│   ┌─────┴──────────────────────────┐          │
│   │ COLLECTOR — Python, on-prem    │          │
│   │ · obix.py is the ONLY file     │          │
│   │   that knows Niagara exists    │          │
│   │ · checkpoint per point         │          │
│   │ · roll-horizon guard           │          │
│   │ · idempotent writes            │          │
│   └─────┬──────────────────────────┘          │
└─────────┼──────────────────────────────────────┘
          │ outbound TLS only
          ▼
   ┌──────────────────────────────────┐
   │ PostgreSQL — bas_* tables        │
   │ irreplaceable beyond ~42h        │
   └──────┬───────────────────────────┘
          │
   ┌──────┴───────────────────────────┐
   │ PLATFORM — Next.js               │
   │ app/(modules)/bas/*              │
   │ app/api/modules/bas/*            │
   │ lib/modules/bas/*                │
   │ never talks to the JACE          │
   └──────────────────────────────────┘
```

**The collector never becomes part of this app.** It is Python, it runs on a
machine inside the building's network, and it is not in this repository. The
platform reads what it wrote and knows nothing about Niagara.

**The platform can never reach the JACE, and must not.** Tridium's hardening
guide: *"A station exposed to the Internet is a station at risk."* Once this app
is in Azure, there is no network path from it to a building controller. Any
future feature that appears to need one is wrong.

**Read-only, by construction.** The Niagara service account holds a read-only
role. Not "should not write" — *cannot*. That account is what stands between a
bug in our code and somebody's chiller. If write-back is ever wanted, it is a
separate service with separate credentials and a human action per change, and
nothing in the current design should be read as a step toward it.

---

## Azure: the container app may sleep, the database may not

**Read this before configuring cost management, auto-shutdown, or any
start/stop automation on this subscription.** Agreed with IT on 24 August 2026.

| Resource | May it be stopped or scaled to zero? |
|---|---|
| Container app (the website) | **Yes, freely.** Scale to zero overnight and at weekends |
| Azure Database for PostgreSQL Flexible Server | **No. Never stop it** |

The two look like the same kind of resource and they are not. What follows is
why, written for someone who has never heard of Niagara.

### What the idle database is actually doing

The database looks idle out of hours because nobody is using the website out of
hours. That is a fact about the website, not about the database.

A building automation controller — the box that runs the heating, cooling and
ventilation in a PH+B project — records a reading from every sensor every few
minutes. It keeps roughly **500 readings per sensor and then overwrites the
oldest, forever.** At our measured five-minute interval that is **41.7 hours** of
memory. There is no alarm when it wraps, no log entry, no gap marker. The
controller simply forgets, silently, and it does this whether or not PH+B is
open, whether or not anyone is signed in, and whether or not the website is
running.

A small on-premises program (the collector) reads that controller every 15
minutes and writes the readings into this database. **That is the only copy that
will ever exist.** Past 41.7 hours the original is gone from the controller and
cannot be re-fetched from anywhere — not from the vendor, not from a backup of
the controller, not by asking again.

So at 3am on a Sunday the database is not idle. It is receiving the only copy of
data that is being destroyed at source on a 41.7-hour timer.

### Why stopping it destroys data rather than merely postponing work

If the database is unreachable, the collector's write fails. That part is
handled: the checkpoint that records how far collection has got **only advances
on committed data**, so a failed run does not skip anything. The collector
retries, and on the next successful run it asks the controller for everything
since its last checkpoint and catches up.

Catching up only works while the controller still remembers. The arithmetic is
the whole rule:

| Outage | Duration | Result |
|---|---|---|
| Overnight, 20:00 → 07:00 | 11 h | **Survivable.** Collector fails, retries, catches up in the morning. Nothing lost |
| Friday evening → Monday morning | **~61 h** | **Data destroyed.** ~19 hours per sensor overwritten before anything read it |
| Long weekend, Friday → Tuesday | ~85 h | Worse in proportion |

An overnight stop is free. A weekend stop is permanent loss. There is no warning
between the two, and the resource looks identically idle in both cases.

**Stopping the database also stops the backup.** The nightly verified `pg_dump`
runs on-premises against this server. A stopped server means no dump, so the
window in which data is being destroyed is also the window in which nothing is
being preserved.

### It has already happened

Not hypothetical. **21–24 August 2026**, before deployment, on the development
machine — the laptop holding the database was closed over a weekend:

- the collector was silent for **64.3 hours** (21 Aug 16:05 → 24 Aug 08:20)
- against a **41.7-hour** roll horizon
- **four points each lost 22.6 hours** of history, permanently

Those four losses are `roll_overwrite` rows in `bas_data_gaps` and are on the
Collection Health screen now. A closed laptop and a stopped Flexible Server are
the same event as far as the controller is concerned.

**22.6 is 64.3 minus 41.7.** The loss is exactly the outage minus the roll
horizon, which is the same subtraction as the table above — so that table is the
mechanism rather than an estimate of it. Any outage longer than 41.7 hours loses
the difference, and no outage shorter than that loses anything.

### Why this is an attractive-looking mistake

Every signal points the wrong way:

- **Burstable-tier Flexible Server can be stopped, and stays stopped.** That is a
  real, documented, deliberate Azure feature, and for most workloads it is good
  advice. `runbook.md` mentions the capability approvingly in a different
  context — diagnosing a server that turns out to be stopped.
- Cost tooling will suggest it. Azure Advisor, cost-management recommendations,
  Dev/Test guidance and most start/stop automation samples all treat a
  low-utilisation database as an obvious saving.
- The metrics agree with them. Connection counts and CPU on this server are
  genuinely near zero out of hours. The cost of stopping it is invisible on every
  screen an Azure administrator will be looking at.
- Nothing fails loudly. There is no error, no alert, and no missing row —
  `bas_readings` is simply thinner than it should have been, in a range nobody
  will query for months.

Even where a stopped server is eventually restarted automatically, that window is
far longer than 41.7 hours, so it is not a safety net.

### The distinction it rests on

**The website and the database have different availability requirements, and it
is very easy to configure them as though they do not.**

Nobody needs the site at 3am on a Sunday. Scale the container app to zero then
and the only consequence is a cold start for whoever signs in first.

For every table except `bas_*`, downtime costs **availability** — the data is
still there when the server comes back. For `bas_readings`, downtime costs
**data**, because the clock that destroys the original is inside a building
controller PH+B does not own and cannot pause.

> The website can be unavailable. The database can only be unavailable for as
> long as the controller can remember, which is 41.7 hours, and nobody is
> measuring how much of that has been used up.

### What to do instead, if the bill needs trimming

All of these are safe and none of them touch availability:

- Scale the container app to zero out of hours. It is the more expensive
  resource of the two.
- Keep the database on the burstable tier — **just never stop it.** The tier is
  the saving; the stop button is not.
- Reduce vCores or storage on the server. Small dataset, low write rate.
- Buy reserved capacity for a server that is, by design, never switched off.
- Shorten backup retention if it is over-provisioned, having first checked
  `runbook.md`, *BAS irreplaceability*.

**If a genuine maintenance stop is unavoidable**, it is safe only while the total
outage stays well inside 41.7 hours, and only if someone confirms afterwards that
no new `roll_overwrite` rows appeared in `bas_data_gaps`. The Collection Health
screen answers that in one look. If the outage cannot be kept inside the roll
horizon, the collector must be stopped deliberately and the loss accepted
knowingly rather than discovered later.

---

## The data model

Twelve tables, `bas_`-prefixed in `public`, defined in `prisma/schema.prisma`
plus hand-written SQL in the `add_bas_tables` migration. **`schema.prisma` is
not the whole story** — see the runbook section *The BAS schema lives in two
places*.

```
bas_orgs
 └── bas_sites                     a building
      └── bas_stations             a JACE (or a Supervisor)
           └── bas_points          one trended value
                └── bas_readings   the numbers
      └── bas_equipment            AHU-3, VAV-204
```

Plus vocabularies (`bas_point_roles`, `bas_equipment_types`), relationships
(`bas_point_links`), and operational tables (`bas_sync_checkpoints`,
`bas_ingest_runs`, `bas_data_gaps`).

### Four invariants that cannot be fixed later

**Point identity is a surrogate key, never a name.** The natural key is
`(station_id, niagara_history_name)`; everything else references `point_id`. A
point renamed in Niagara appears as a *new* row rather than silently
reinterpreting years of history.

**Every timestamp is `timestamptz`, stored UTC.** Local time is display only,
derived from the site's IANA zone. There is no way to unwind a DST bug
afterwards.

**`bas_readings` carries no names, units, or equipment.** Denormalising those
multiplies storage roughly 5× and turns a rename into a billion-row rewrite.
Join to `bas_points`.

**History names are stored exactly as Niagara returns them**, including `$`-hex
escapes — `$20` is a space, `$2d` a dash. That string goes into the oBIX URL
verbatim. Decoding and re-encoding is not reliably round-trippable and produces
404s indistinguishable from a missing point.

### `point_role` is the highest-leverage field in the schema

A small controlled vocabulary — `supply_air_temp`, `supply_air_temp_sp`,
`cooling_valve_cmd`, `zone_temp`, `oat` — assigned per point.

Without it, every question degenerates into string-matching against whatever
naming convention that building's integrator happened to use. With it,
*"compare supply air temperature across all air handlers"* is
`WHERE point_role = 'supply_air_temp'` and it works across buildings, naming
schemes and vendors.

Two roles reference other roles, and that is what makes generic questions
possible:

- `setpoint_for` — `supply_air_temp_sp → supply_air_temp` answers *"which units
  never reached setpoint"*
- `status_of` — `supply_fan_status → supply_fan_cmd` answers *"commanded on but
  not running"*, a real and expensive fault

**A point with no role is invisible** to every cross-equipment comparison and
every generic rule. Unclassified points are therefore surfaced as a visible
backlog on the health screen, not hidden.

**The vocabularies are tables, not Postgres enums, deliberately.** An analyst —
or a language model writing SQL — can `SELECT` from a table to discover what
values exist and what they mean. An enum is invisible from inside a query.

### A null reading is not a missing reading

`bas_readings` allows a row with **zero** populated value columns. That is a
record the station returned as null — a sensor fault, or a genuine gap. It is
different from **no row at all**, which means we never collected. Analysis that
conflates the two will confidently report equipment shutdowns that never
happened.

`bas_data_gaps` records known-missing periods and why. The cause that matters is
`roll_overwrite`: the station destroyed the data before we read it. Every
occurrence means the poll cadence is wrong for that point.

### `bas_readings.status` is never supplied, and NULL does not mean "no fault"

**Measured on 24 August 2026: 0 of 5,759 readings across all four points carry a
status. It is not a bug, and it will not change on this extraction path.**

The oBIX `~historyQuery` response carries a `#RecordDef` prototype declaring
exactly what each record contains. For these histories it declares two fields and
no more:

```xml
<abstime name="timestamp" tz="Etc/UTC"/>
<real name="value" unit="obix:units/fahrenheit"/>
```

Niagara does not send status with history records over this path. **The collector
is not dropping it.** There is nothing to fix in the code.

**NULL here means "not supplied". It never means "no fault".** Those are opposite
readings of the same empty column, and the wrong one is the comfortable one: a
reader who sees NULL and concludes *the station reported no problems* has
inverted the meaning of the data. The truth is that the station was never asked
and never told us. The column comment in the database says this in as many words,
because `bas_v_data_dictionary` feeds column comments to a language model that
will write SQL against it.

**The column stays.** A Supervisor or a different extraction path may populate it
later, and an always-null column is cheaper than a migration.

#### The consequence is the design, not a gap to work around

Fault detection on this data is **value-based only**. We cannot ask what the
station believes about a reading — only what the reading was.

That is a better position than it sounds. A rule that says *a room temperature of
-40 is not a temperature* works on Johnson Controls and Siemens too. PH+B is a
mechanical contractor and its portfolio will not be all Niagara, so a fault
library built on values ports to the next building and one built on vendor status
flags does not. The first real fault this system found — see the runbook,
*points_RoomT went to -40* — was caught from the value alone, with no help from
the station.

#### Two routes that could supply status later — both UNVERIFIED

Neither is a plan. Neither has been tried. They are written down so that nobody
re-derives them, and marked so that nobody treats them as scheduled work.

**oBIX points carry a status facet even though history records do not.** Reading
each point's current value *and* status alongside the history would be a small
collector addition. It would give *"the station says this point is in fault right
now"* — never *"the station thought this at 3am last Tuesday"*. Present-tense
only, and therefore not useful for analysing history.

**Alarm extensions are how Niagara buildings actually signal this**, and alarms
are separately queryable. This is the route that matches how the building is
really engineered. It is Niagara engineering work with its own extraction path,
not a configuration toggle.

#### One thing that is genuinely unknown

**Whether the history itself can be configured to include status is UNKNOWN.**
Do not assert either way — not in a commit message, not in a ticket, and not to a
customer.

What would settle it, in Workbench:

- what record type the history extension logs, and whether a record type carrying
  status is available and selectable for these points;
- whether the `ObixNetwork` exposes anything about record fields, or whether the
  `#RecordDef` prototype is fixed by the history's own configuration.

Until somebody looks, the honest answer is that we do not know.

---

## What the module does

### Collection Health

Is data arriving, and is any of it about to be lost. Five tiles, a per-point
table, the recent collector runs and the recorded data gaps, reading
`bas_ingest_runs`, `bas_data_gaps` and `bas_v_collection_health`.

**Two controls, and they scope different things.** *Building* — All or one site
— scopes every panel without exception. *Range* — 24 hours, 7 days, 30 days —
scopes only the run list, the run chart and the collector-silence calculation;
the tiles, the per-point table and the recorded gaps are statements about the
present and windowing them would mean nothing. Both are applied in SQL, never by
hiding rows in the browser. Whatever is selected is restated in words above the
data, because a reader who has lost track of the filter cannot tell a real zero
from a filtered one.

**Two tiles have semantics worth stating.** *Points at risk* counts `data_lost`
— the station overwrote records before we collected them, permanently — and
`roll_horizon_unknown`, meaning capacity has not been filled in from Workbench
so we cannot tell. **Unknown is not the same as safe and must never render
green.** *Unclassified points* is amber by design: an unclassified point is a
backlog item, not an error.

### Point Explorer

Point picker, trend chart, summary tiles, known gaps - one point at a time,
because `points_RoomT` is in fahrenheit and `Temp1`..`Temp3` carry no unit at
all, and two of those on one axis is how 55 degF and 12.8 degC end up on one
line.

**The trend line breaks across gaps rather than drawing through them.** A
straight segment across a hole asserts readings that were never taken, and on
21-22 August 2026 the station destroyed 22.7 hours of every point here.

**Use distinct-value count, not standard deviation, to judge whether a sensor is
alive.** A standard-deviation threshold is unit-dependent and untunable across
buildings; it missed a sensor frozen at 64.5 with σ = 0.08. Distinct-value count
is unit-independent — a live sensor produces many values, a dead one produces a
handful.

### Ask

An employee types a question. The platform decides which tools to call, the
**database** computes the answer, and the model explains it.

**The model never does arithmetic on trend rows.** Given thousands of numbers a
language model produces a plausible wrong average with nothing signalling it
went astray. Ask for a month and the tool buckets the data and says so.

**Three independent protections on the SQL escape hatch**, because these tables
cannot be restored from source:

1. a Postgres role with no write permission — **its own connection pool, not the
   Prisma client**, which has write access because the rest of the platform
   needs it
2. read-only transactions
3. a validator rejecting anything that is not a `SELECT`

Any one of them could have a hole. All three having the same hole is unlikely.

**Use the right tool for the question.** Rules and SQL for anything
deterministic; the model as an orchestrator and explainer.

| Question | Answered by |
|---|---|
| Trend viewing, comparison across equipment | SQL |
| Classic HVAC faults — simultaneous heat/cool, stuck sensors, unoccupied runtime | **deterministic rules** |
| Anomaly detection | rolling median + MAD |
| "Why did zone 4 overheat Tuesday?" | model orchestrating the above |

Most valuable fault detection is rules, not machine learning. Simultaneous
heating and cooling, economizers not economizing, equipment running while
unoccupied — all deterministic, all explainable, most of them codified in ASHRAE
Guideline 36. Build rules first.

---

## How to build it

Each phase ships runbook entries as it goes — symptom, cause, fix — per
`docs/07-conventions.md`. Nothing starts before the previous phase is
demonstrably done.

### B1 — schema — COMPLETE, with a corrupted import still on disk

Twelve models, one migration, the data import. Commit `56f2811`.

Verified: 12 tables, 6 views, `migrate dev --create-only` produces an empty
migration, import reconciled 12/12 tables and 3,481 rows with point ids
preserved, 416/416 tests green.

**That 416/416 was meaningless** — it ran against a test database with none of
these twelve tables, because `prisma migrate deploy` reaches `DATABASE_URL` and
only `npm run db:test:setup` reaches `TEST_DATABASE_URL`. B1 has tests now:
`tests/bas-schema.test.ts` and `tests/bas-views.test.ts`, 61 of them, ported from
`C:\dev\bas-db\scripts\verify.py` and covering the half of the schema Prisma
cannot see — the CHECK constraints, the `roll_horizon_s` trigger, and the six
views. `tests/global-setup.ts` now refuses to let the suite start against a test
database that is behind the migrations.

**Three gaps that were only visible once something looked**, all now closed.
Each has a runbook entry, because each will be someone else's confusing afternoon
if it comes back:

- **The vocabularies were created by nothing.** 91 point roles and 25 equipment
  types reached the development database only because `scripts/bas-import.ts`
  copied them out of the standalone database. A fresh database came up with an
  empty vocabulary, every point read as unclassified, both pairing views returned
  zero rows, and nothing errored. They are reference data and now live in
  `prisma/bas-vocabularies.ts`, installed by the seed alongside positions and
  departments, in two passes because `setpoint_for` and `status_of` are
  self-referencing. Proven on a fresh database: 91 / 25 / 12 links / 8 links,
  every link resolving, byte-identical to what the import produced, and a second
  run changing nothing.
- **`bas_v_data_dictionary` had 211 rows and 2 annotated columns.** The port
  dropped 20 of 22 `COMMENT ON COLUMN` and all 12 `COMMENT ON TABLE`, because
  the prose moved into `schema.prisma` `///` comments and Prisma does not emit
  those as SQL comments — they are invisible from inside a query. Restored by the
  `add_bas_comments` migration: 22 annotated columns and 18 of 18 objects
  described. B5's premise now holds.
- **`prisma generate` was forced by nothing.** `lib/generated/prisma` sat twelve
  models stale through B1 and B2. `package.json` now declares
  `postinstall: prisma generate`, and Dockerfile stage 1 copies `prisma/` and
  `prisma.config.ts` before `npm ci` so that hook has a schema to read — without
  which the image build fails, verified by reproducing it.

**The import itself was wrong, and the data in the development database still
is.** It verified by row count, reported `12/12 tables reconciled, 3,481 rows`,
and had truncated every microsecond timestamp to milliseconds (107 of 107 values)
and turned `bas_ingest_runs.errors` from a jsonb array into a jsonb object.
Counts matched exactly on both sides. `bas_readings` - the irreplaceable table -
was intact, because the collector writes milliseconds there anyway.

`scripts/bas-import.ts` now reads every lossy type as raw text and verifies by
content, and `npm run bas:verify` runs the same comparison after the fact. A
re-import fixes the existing rows and has not been run. Full account in the
runbook under *The first BAS import corrupted every timestamp*.

**What is still open**, and it is not a defect: `bas_points.point_role` is NULL
for all seven points in the development database. The vocabulary exists to
classify against, and nothing has been classified — deliberately, per *The state
of the data* below. Classification tooling is in *Deliberately not built*.

### B2 — module registration and the guard — COMPLETE

- `bas` row in `prisma/seed.ts` — key `bas`, displayName **Building Automation**
- `lib/modules/bas/constants.ts` exporting `BAS_MODULE_KEY`
- `lib/modules/bas/route-helpers.ts` — a `withBas` wrapper modelled on
  `withMailbox`, same three-step order: **authorization, then validation, then
  connectivity**. An unauthenticated caller must not learn what a valid request
  body looks like.
- `app/(modules)/bas/page.tsx` — `requireModuleAccess` then `notFound()`
- `app/api/modules/bas/ping/route.ts`

**Done when** the module appears in the sidebar for a granted employee, and an
ungranted employee hitting the route directly by URL gets **404, not 403** —
asserted in a test, not tried in a browser. The platform does not confirm that a
module exists to someone who cannot use it.

Verified: 447/447 tests (416 before B2), typecheck and lint clean. The sidebar
item is asserted by rendering the real `Sidebar` with the modules the real
`AppShell` hands it, so it needs no interactive sign-in to re-check. Route and
page both answer `404` for an ungranted employee, and `withBas` refuses to run
the Zod parser before the grant check. Four runbook entries added — the test
database being twelve tables behind was the one that cost time.

### B3 — Collection Health — COMPLETE

Service layer in `lib/modules/bas/service.ts`, **employee-parameterised from day
one** so per-site scoping later is a one-place change.

**Done when** every number matches the equivalent Grafana panel for the same
window, and someone other than the author can tell whether data is flowing.

*Grafana is the oracle for B3 and B4.* It reads the same database and its
queries are already validated. Point a new screen at the same window and the
numbers either agree or the screen is wrong. Grafana is a development tool, not
a deliverable — the module is the deliverable.

Verified 24 August 2026. All nine panels, plus every column of the per-point
table, compared against the dashboard's own SQL by
`scripts/bas-health-oracle.ts` — every number matched. 611/611 tests (554
before B3), typecheck, lint and build clean.

**What was built.** One route, `/api/modules/bas/collection-health`, answering
the whole screen in one payload; `getCollectionHealth` reads all of it inside
one transaction so that `now()` is the same instant for the tiles, the per-point
"minutes ago" and the view's `roll_risk`. Five tiles, the per-point table,
records-per-run, recent runs, and — added deliberately — the recorded data gaps,
which is the ninth Grafana panel and the only one that shows data already
destroyed.

**Recharts, added here rather than in B4.** The records-per-run panel needs a
real time axis: a bar chart spaced evenly by run number draws 21 August and 24
August adjacent and erases a 64-hour outage entirely. That is the one thing this
screen may not do. It costs ~114 kB on `/bas` and nothing on any other route.

**The two controls were added after B3 shipped**, on 24 August 2026. The building
filter is built against a two-building test fixture rather than the one real
site, because with a single building `All` and `the only building` return the
same rows and a filter that was ignored entirely would pass every assertion. The
service separates ENTITLEMENT (which sites an employee may see - `basSiteScope`,
the one place per-site grants will land) from SELECTION (which one they asked
for), and intersects them; a building outside the entitlement answers 404, the
same as a missing module grant. Verified with `npm run bas:oracle -- --site N
--days N`, which reproduces Grafana's `$site` variable and time range.

That work also found the per-point table reshuffling itself on every refresh:
`seconds_since_last_record` is whole seconds, the collector writes every point in
one poll, so they tie exactly and PostgreSQL returned tied rows in a different
order each time. Fixed with a deterministic tie-break. See the runbook, *The
per-point table reshuffles itself every refresh* - the general rule being that
any `ORDER BY` on a truncated duration needs one.

**`withBas` now caches the affirmative availability answer**, and only the
affirmative one. B2 left `to_regclass` uncached because it was one ping route;
this screen polls. A database that *gains* the migration is still picked up on
the next request, because "missing" is never remembered, and a transient Postgres
failure is not remembered either.

**Two things this phase found that were not about B3.**

*Every timestamp Prisma wrote was four hours out.* Prisma's driver adapter
discards the offset on a `timestamptz` in both directions, so a Prisma round trip
cancels out and every comparison against `now()` is wrong by the session's UTC
offset. It had been true since Phase 1. Fixed by pinning the session to UTC in
`lib/db/adapter.ts`, which every client now goes through. Full account in
`runbook.md`, *Timestamps written through Prisma were four hours out*.

*The tiles can be green while ninety point-hours are gone.* `roll_risk` asks a
question about the present, so once collection resumes every point returns to
`ok` and the tiles have no memory of an outage. The *longest collector silence*
banner and the *recorded data gaps* table exist precisely to carry that memory.
See the runbook, *Collection Health says everything is fine and you know it is
not*.

### B4 — Point Explorer — COMPLETE

The charting library is already here: B3 added **Recharts 3** for the
records-per-run panel, because that panel needs a real time axis.

**Done when** you can answer *"what did this point do yesterday"* without SQL,
and it matches Grafana.

Verified 24 August 2026. Every panel of both dashboards matched via
`npm run bas:oracle`, across all four points and both the 1-day and 7-day
windows. 710/710 tests (639 before B4), typecheck, lint and build clean.

**The module became tabbed.** `/bas` is Collection Health, `/bas/points` is Point
Explorer, and both are real routes - bookmarkable, refreshable, middle-clickable.
The sidebar keeps exactly one *Building Automation* entry. `tabs.ts` is the whole
extension point; B5 is one line there plus a page.

*Each tab guards itself*, and the chrome is deliberately NOT a Next.js layout: a
layout renders around a page that calls `notFound()`, so an ungranted employee
would get the module heading and tab bar wrapped around a 404. See the runbook,
*The Building Automation tabs are routes, not state*.

*The filters live in the URL* - `site`, `days`, `point` - which is what makes
them survive a tab switch, a refresh and a bookmark. A filter that silently
resets is worse than none: a filtered zero and a real zero look identical.

**Four things this screen has to get right**, each with its own runbook section:

1. **Distinct values, not standard deviation** for judging whether a sensor is
   alive. Sigma is unit-dependent, untunable across buildings, and points the
   wrong way - a stuck sensor and a stable room both have low sigma. Live: Temp1
   gives 254 distinct across 286 readings in 24 h.
2. **The trend breaks across gaps.** Worth being precise about which gap: the
   *collector* was silent 64.3 h, but the hole in the *readings* is 22.7 h,
   because the backfill recovered everything the station still held. Three
   mechanisms - an inserted null with `connectNulls={false}`, a shaded band, and
   a written list - because a break alone reads as a rendering artifact.
3. **A null reading is not a missing reading.** The readings/nulls tile carries
   two numbers because "0 nulls, 286 rows" and "0 nulls, 0 rows" both report zero
   and mean opposite things.
4. **Units.** One point at a time, matching Grafana's `multi: false`, so two
   units can never share an axis. The axis says "no unit recorded" rather than
   going bare, because bare reads as *none needed* and the truth is *unknown*.

### B5 — Ask

Eight tools: point inventory, roles, schema, readings, per-point summary, fault
rules, collection health, and the guarded SQL escape hatch. An audit event per
question — `bas.question_asked`, following the dotted-string convention.

**The API key is read lazily**, exactly like `GRAPH_*`. A missing key disables
this one feature; it must never stop the platform booting.

**Done when** the platform answers a question correctly, and a write attempted
through the SQL tool fails **at the database level** with the validator bypassed.

### B6 — point the collector at this database — BLOCKED

*It is not one connection string.* Attempted 24 August 2026 and stopped before
any change was made.

The collector's SQL is schema-qualified and singular throughout - `bas.reading`,
`bas.point`, `bas.station`, `bas.v_collection_health` - about thirty statements
in `collector/db.py` plus a few in `cli.py`. The platform has
`public.bas_readings`, `public.bas_points`, `public.bas_stations`. Pointing
`DATABASE_URL` at the platform makes `collector check` report *"connected, but
the bas schema is missing"*, and `collector sync` abort on its first write.

Views in a `bas` schema do not rescue it: the collector uses `INSERT … ON
CONFLICT` everywhere and PostgreSQL does not support `ON CONFLICT` on a view.
`search_path` does not either, because the names are already qualified. The only
route is renaming the references inside the collector - a real change to the one
component validated against real hardware, needing its own decision and its own
before-and-after run against the station.

**Repointing anyway is the harmful move.** The 15-minute sync task is currently
the only thing collecting anything, so a collector that cannot write means no
collection at all, against a 41.7-hour roll horizon. Two days of that is a
permanent hole.

Changing that one line also repoints the nightly 02:15 backup, whose
verification step then fails on every run - it looks for the standalone schema's
table names. The dump is fine; the check is not. Both are in `runbook.md`
under *B6 is blocked* and *Repointing the collector also repoints the nightly
backup*, with a tested patch for the backup script.

**Still done when** seven consecutive days of collection land with no gaps.

---

## Decisions, with reasons

| Decision | Why | Reversible? |
|---|---|---|
| **oBIX over HTTPS** for extraction | The only free, documented, external, incremental path that carries units and timezone. There is no first-party REST/JSON history API in Niagara 4 | Yes — one adapter file |
| **External pull, nothing installed on the JACE** | Protects building control, and leaves nothing to refactor when Niagara 5 lands | Yes |
| **Read-only Niagara account** | Guarantees this module cannot affect a chiller, by construction | **Never** |
| **Collector stays Python, outside this repo** | It is the only component validated against real hardware. A rewrite means re-earning every bug already paid for | Yes, at that cost |
| **Prisma owns the schema anyway** | `docs/05` requires it, and two migration systems against one database is a hazard. No conflict with the above: the collector needs `INSERT … ON CONFLICT`, not DDL | Expensive once data accumulates |
| **`roll_horizon_s` maintained by a trigger, not a generated column** | Prisma reads `GENERATED ALWAYS AS` as a default it cannot express, and proposes an `ALTER … DROP DEFAULT` that Postgres rejects — permanently blocking migrations. Prisma ignores triggers | No |
| **Views named `bas_v_*`** | `bas_v_data_dictionary` filters on `LIKE 'bas\_%'`. Unprefixed views would be invisible to the AI | No |
| **Store history; override `docs/05`** | Niagara is a two-day buffer, not a system of record | **No — foundational** |
| **Grafana as verification tool only** | The platform exists to be the one place these things live | Yes |
| **Poll every ~15 minutes, not nightly** | Counterintuitive: frequent polling is *gentler*. Same daily volume, smaller peak memory in the station's heap, far more margin before overwrite | Yes |
| **The Azure PostgreSQL server is never stopped; the container app may scale to zero** | The website and the database have different availability requirements. Downtime costs availability for every other table and *data* for `bas_readings`, because the clock that destroys the original runs inside a controller PH+B does not own | **No — a weekend of it is unrecoverable** |

---

## Deliberately not built

**Point classification tooling.** Bulk-assign roles by name pattern, create
equipment, link points. The right shape depends entirely on how a given
building's integrator named things, and guessing against three synthetic points
would be wasted work. Most fault rules need `equipment_id` and nothing currently
sets it.

**Anything requiring a Supervisor.** `bas_stations.parent_station_id` is a
nullable self-reference, which is the whole mechanism by which a Supervisor
stays optional forever. Introducing one later needs no schema change.

**Write-back to the station.** See *Shape*.

**Per-site access scoping.** The service layer takes the employee as a
parameter from day one, so adding a `bas_site_grant` table later is a change in
one place rather than in every route. Not needed for one building.

---

## The state of the data, as of 21 August 2026

**It is synthetic.** The lab station at `196.1.1.213` has four active points:
`Temp1`, `Temp2` and `Temp3` come from Niagara's History Emulator and nobody
knows what they represent, and `points_RoomT` is real and reads in Fahrenheit.
They are left unclassified on purpose — inventing a `point_role` would make the
AI answer confidently about something untrue.

That station is also **not PH+B's asset**. Its licence belongs to Building
Controls & Solutions under a Columbus Temperature Controls project.

**Access to a production JACE is the open dependency**, and the question that
matters most is not the IP address — it is *whether history extensions are
configured on it at all*. If nobody ever set them up, this becomes a Niagara
engineering job before it is a data job.

Everything in B2 through B6 can be built against synthetic data. Whether it is
*useful* is not knowable until a real building is behind it.
