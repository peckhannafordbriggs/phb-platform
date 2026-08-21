# BAS — building automation data

What the module is, why it is shaped the way it is, and how to build it.

Read this before touching anything under `bas_*`, `lib/modules/bas`, or
`scripts/bas-import.ts`. Operational failure modes are in `docs/runbook.md`
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

---

## What the module does

### Collection Health

Is data arriving, and is any of it about to be lost. Five tiles, a per-point
table, and the recent collector runs, reading `bas_ingest_runs` and
`bas_v_collection_health`.

**Two tiles have semantics worth stating.** *Points at risk* counts `data_lost`
— the station overwrote records before we collected them, permanently — and
`roll_horizon_unknown`, meaning capacity has not been filled in from Workbench
so we cannot tell. **Unknown is not the same as safe and must never render
green.** *Unclassified points* is amber by design: an unclassified point is a
backlog item, not an error.

### Point Explorer

Point picker, trend chart, summary tiles, known gaps.

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

### B1 — schema — COMPLETE

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

### B3 — Collection Health

Service layer in `lib/modules/bas/service.ts`, **employee-parameterised from day
one** so per-site scoping later is a one-place change.

**Done when** every number matches the equivalent Grafana panel for the same
window, and someone other than the author can tell whether data is flowing.

*Grafana is the oracle for B3 and B4.* It reads the same database and its
queries are already validated. Point a new screen at the same window and the
numbers either agree or the screen is wrong. Grafana is a development tool, not
a deliverable — the module is the deliverable.

### B4 — Point Explorer

Adds a charting library. Recharts unless there is a reason otherwise.

**Done when** you can answer *"what did this point do yesterday"* without SQL,
and it matches Grafana.

### B5 — Ask

Eight tools: point inventory, roles, schema, readings, per-point summary, fault
rules, collection health, and the guarded SQL escape hatch. An audit event per
question — `bas.question_asked`, following the dotted-string convention.

**The API key is read lazily**, exactly like `GRAPH_*`. A missing key disables
this one feature; it must never stop the platform booting.

**Done when** the platform answers a question correctly, and a write attempted
through the SQL tool fails **at the database level** with the validator bypassed.

### B6 — point the collector at this database

One connection string locally. In production: a firewall rule for the site's
egress IP, TLS enforced, and a `bas_collector` role with write access to
`bas_*` and nothing else.

**Done when** seven consecutive days of collection land with no gaps.

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
