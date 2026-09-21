# BAS B5 — Asking questions of the sensor data

Read `CLAUDE.md`, `docs/08-bas-and-niagara.md`, `docs/09-bas-what-is-built.md`, and
`WHY-ITS-BUILT-THIS-WAY.md` first.

---

## Goal

Someone with the BAS grant types a question in plain English and gets an answer drawn
from the sensor data, along with enough provenance to check it.

The model writes SQL. It runs on a read-only connection. Every answer shows what was
actually queried.

---

## The thing this feature can get wrong

Every other part of BAS is designed around one idea: **the failure mode to design against
is silence.** Gaps are drawn three ways. Unknown never renders green. A tile says "3
points, capacity unknown" rather than a clean number computed from the points that
happened to have one.

A question-answering box is the easiest place in the entire platform to undo all of that.
It can say "the average was 68°F last week" in a confident sentence while 22 hours of
that week never existed, and nothing about the sentence reveals it.

So the bar is not "does it answer." It is **does a wrong or partial answer look
different from a right one.**

---

## What the model may and may not do

**May:** write a `SELECT` against the `bas_*` tables and views, and read the schema
description it is given.

**May not:** write anything, read outside `bas_*`, or take any action. There is no tool
here that changes state, sends anything, or touches another module.

---

## Safety, in the code rather than the prompt

The prompt is the only lever on the model's behaviour, and prompts get ignored. Every
guarantee below is enforced by something other than instructions.

**A real read-only role.** A dedicated Postgres role with `SELECT` on `bas_*` and
nothing else — no write grant to revoke, no access to `employees` or `audit_events`. The
same shape as `bas_readonly_platform`, and verified by testing the refusals rather than
the grants. This is the boundary; everything else is depth.

**Statement timeout and row cap.** The collector writes to this database every 15
minutes, and a bad join must not be able to starve it. A short statement timeout, a hard
row limit, and a cap on how long the whole request may take.

**Single-statement enforcement.** Reject anything containing a second statement, a
semicolon followed by more SQL, or a CTE that writes. Parse it rather than pattern-match
it if the parse is cheap.

**Prompt injection is live here.** Point names and site names come from Niagara and are
attacker-influenced in principle. Pass data as data, never as instructions, and never let
retrieved content change what the model is allowed to do. The read-only role is what
makes the worst case a wrong answer rather than a wrong action.

**Every query logged** with the question that produced it, the SQL, the row count and the
duration. That log is how you learn what people actually ask, and the only way to audit a
wrong answer after the fact.

---

## Provenance, not confidence

**No confidence score.** The model has no calibrated sense of whether its SQL was right,
so a number would look authoritative and mean nothing. That is worse than no number.

Show what is actually true instead. With every answer:

- **The SQL that ran**, in full, collapsed by default but always available
- **Row count** returned
- **The time range** the query covered, as resolved — "last week" became these two
  timestamps
- **Which points and sites** the answer draws on, by name
- **Gap overlap** — whether any recorded `bas_data_gaps` intersect the time range
  queried, and how many hours. This is the one that matters most, and it must appear
  whether or not the model thought to mention it
- **Whether any point in scope has an unknown roll horizon**, for the same reason the
  tiles say so

Gap overlap and unknown-horizon are computed by **our code after the query runs**, from
the time range and points involved. They are not something the model is asked to
remember.

---

## Saying "I don't know"

This must be a real path, not a politeness the prompt requests.

- **Zero rows is not zero.** A query returning nothing means "no data matched," which is
  different from "the answer is zero." The two must never render the same way.
- **If the model cannot produce valid SQL**, or the SQL errors, say so plainly and show
  what it tried. Do not retry silently more than once, and say if a retry happened.
- **If the question needs data that does not exist** — a point that was never collected,
  a period before collection started, equipment relationships that nothing has set — the
  answer says that rather than answering a nearby question instead.
- **If the time range is partly outside the data**, say so and give the range that is
  actually covered.

An answer that begins "I can't tell you that, because..." is a success.

---

## The schema traps the prompt must carry

These exist because people get them wrong, and an AI writing SQL will get them wrong the
same way. From `WHY-ITS-BUILT-THIS-WAY.md` and `docs/08`:

- `bas_readings` holds a point reference, a timestamp and a value. **No names, no units,
  no equipment.** Joins are required for any of that
- **Point identity is a surrogate key.** A point renamed in Niagara is a *new row*, so
  "the history of this point" may be split across two ids
- **Every timestamp is UTC.** Local time is display only
- **`status` is always NULL** — Niagara does not send it. NULL means "not supplied,"
  never "no fault." Fault detection here is value-based
- **A gap means we were not watching**, not that equipment was off
- **Unclassified points have no role**, so any question phrased by what a point measures
  silently excludes them. Say when that happened
- **`bas_v_data_dictionary`** exists for exactly this purpose — the model should be given
  the schema through it rather than a hand-written description that drifts

---

## Scope

**In:** a question box on the BAS module, behind the existing `withBas` guard. Questions
about readings, points, sites, gaps, collection health and trends over time.

**Out of scope:**

- Anything that writes, anywhere
- Questions outside BAS — no mailbox, no employees, no cross-module data
- Charts generated by the model. If a visual would help, point at the existing Point
  Explorer with the right filters rather than inventing a second charting path
- Conversation memory across sessions
- Scheduled or automated questions. A human asks, a human reads

---

## Hard constraints

- **No write path.** The connection cannot write; a test proves the refusal
- The read-only role has no access to `employees`, `audit_events`, or any non-`bas_`
  table — proven by testing the refusal
- All existing tests pass; nothing here changes the collector, the dashboards, or the
  schema
- The Anthropic key is read lazily like the Graph variables — the platform boots and the
  rest of BAS works with no key configured, and the question box says it is not
  configured
- Rate limit per employee. One person cannot spend the organization's tokens by holding
  down Enter

---

## Acceptance criteria

**Automated**

- [ ] Build, typecheck, lint clean; all existing tests pass
- [ ] The query role cannot write — tested against a real database, not mocked
- [ ] The query role cannot read `employees` or `audit_events` — tested
- [ ] Multi-statement SQL is rejected
- [ ] A writing CTE is rejected
- [ ] Statement timeout enforced and tested
- [ ] Row cap enforced and tested
- [ ] Zero rows renders differently from a zero result — tested
- [ ] Gap overlap is computed by our code, not taken from the model — tested with a
      query spanning a known gap
- [ ] Unauthenticated → 401; no BAS grant → 404
- [ ] Missing API key → a clear not-configured state, not a crash
- [ ] Every request logged with question, SQL, row count, duration
- [ ] Rate limiting works

**Manual, against the real data**

- [ ] "What was the average room temperature last week" returns an answer *and* flags the
      64-hour gap
- [ ] A question about a point that was never collected says so
- [ ] A question about a period before collection began says so
- [ ] A question needing equipment relationships says nothing has set them
- [ ] The SQL shown actually matches what ran
- [ ] A deliberately ambiguous question asks for clarification rather than guessing

---

## Notes for the implementer

**Start with the honesty cases, not the happy path.** Build "I don't know," zero-rows,
and gap-overlap first, and make the ordinary answer work afterwards. If it is built the
other way round, the honest paths become error handling bolted on, and they are the
feature.

**The gap overlap is the single most valuable thing here.** It is what makes this
consistent with the rest of BAS instead of a contradiction of it.

**Log everything and look at the log.** The questions people actually ask will not be the
ones either of us would predict, and that log is what tells you whether this is useful or
a novelty.

**Stop and ask** before adding any tool that writes, before widening the role's access,
before letting a model response name a table or column that our code then trusts, and
before anything that would let this run without a human asking.
