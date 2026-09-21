# BAS B5 — Analyze — verification record

**Date:** 2026-09-21. **Branch:** `feat/bas-analyze`. **Spec:** `docs/BAS-B5.md`.

This file says what was observed and what was not. Where a claim was inferred
rather than seen, it says so. The two halves of the spec's acceptance criteria
are treated separately because they ended differently: every automated
criterion is met against a real database; every manual criterion is **open**,
because the Anthropic key supplied is refused.

---

## Automated criteria — all met

Run against the real test database (`phb_platform_test`, PostgreSQL 17.11)
through a throwaway copy of the `bas_analyze` role built from the exact
statements the production role is built from. The model is faked in every
automated test; nothing else is.

| Criterion | Where proved | Observed |
|---|---|---|
| Build, typecheck, lint clean; all existing tests pass | `npm run typecheck`, `npm run lint`, `npm test` | Full suite 72 files / 1644 tests green before the last wording change; the 4 affected files (105 tests) re-run green after it. Build: see below |
| The query role cannot write — real database | `tests/bas-analyze-role.test.ts` | INSERT, UPDATE, DELETE, TRUNCATE, CREATE TABLE, `nextval()` all `42501 insufficient_privilege` **with `default_transaction_read_only = off`**, so the grant is what refused. `bas_orgs` count unchanged |
| The query role cannot read `employees` or `audit_events` | same | `42501` on every platform table (`employees`, `audit_events`, `module_grants`, `modules`, `positions`, `departments`, `draft_locks`, `_prisma_migrations`) and on `bas_station_credentials` |
| Multi-statement SQL is rejected | `tests/bas-analyze-sql-guard.test.ts`, `tests/bas-analyze-role.test.ts` | Guard: `SELECT 1; SELECT 2` → "Only one statement is allowed"; `SELECT 1; -- comment` also refused. Protocol: with the guard bypassed, `DECLARE … FOR SELECT 1; SELECT 2` is refused over the extended protocol. **See finding 1** |
| A writing CTE is rejected | both | Guard: `WITH d AS (DELETE …) SELECT` → names `DELETE`. Database, guard bypassed: refused with `0A000` by the cursor itself. **See finding 3** |
| Statement timeout enforced and tested | role test | `SELECT pg_sleep(5)` under a 300 ms `SET LOCAL statement_timeout` → `57014`, `timedOut: true`, in under 4 s |
| Row cap enforced and tested | role test | `generate_series(1, 1000)` with cap 200 → 200 rows, `truncated: true`; exactly 200 → `truncated: false` |
| Zero rows renders differently from a zero result | `tests/bas-analyze-service.test.ts`, `tests/bas-analyze-ui.test.tsx` | No rows → kind `no_data`, heading *No data matched*, amber, no `<td>`, summariser never called. One row all-NULL → `no_data` too, row shown as `NULL`. `avg = 0` → kind `answered`, `<td>0</td>`. Markup asserted different |
| Gap overlap computed by our code, with a query spanning a known gap | service test | Fixture: 64 h gap inside the range + 48 h gap straddling its end. Plan said nothing about gaps. Provenance: **68 h**, two items, second clipped to 4 h ending exactly at the range end. Scope widened to every point when the plan named none or named a non-existent id; `gaps: null` when no time range |
| Unauthenticated → 401; no BAS grant → 404 | `tests/bas-analyze-route.test.ts` | 401 / 404 on both GET and POST; 404 body identical to every other BAS route |
| Missing API key → clear not-configured state, not a crash | route and service tests | GET returns `{configured:false, missing:[names]}`; POST returns 200 with `kind: "not_configured"`; blank strings count as missing |
| Every request logged with question, SQL, row count, duration | service test | One `bas.analyze.question` line and one `bas.question_asked` audit row per question, both carrying question, SQL, `rowCount`, `durationMs`, outcome. Audit sentence: *Jim Schwarz asked Building Automation "…"* |
| Rate limiting works | service and route tests | 2-per-window limiter refuses the third, does not count refusals, slides after the window; per-employee; route maps it to 429 `rate_limited` before any pool or model use |

---

## Manual criteria — OPEN, blocked on the key

`npm run bas:analyze:verify` asks the six spec questions through the same
`analyzeQuestion` the route uses, against the **development database**
(`phb_platform`, 19 `bas_*` objects, 39 points, real PHBoffice data) with the
real `bas_analyze` role and the real planner. Run twice on 2026-09-21.

**What happened:** every question returned `cannot_answer` in about 0.1 s.
Anthropic answered `401 authentication_error: "API key is invalid."` to a
plain `messages.create` and to `messages.parse` alike (probed directly, outside
the platform, to rule out the platform). The key is present, 108 characters,
`sk-ant-api03-…`, no whitespace or quotes. **Nothing was queried** on any of
the six.

So none of these has been observed:

- [ ] "What was the average room temperature last week" returns an answer
      **and** flags the 64-hour gap
- [ ] A question about a point that was never collected says so
- [ ] A question about a period before collection began says so
- [ ] A question needing equipment relationships says nothing has set them
- [ ] The SQL shown actually matches what ran
- [ ] A deliberately ambiguous question asks for clarification rather than
      guessing

Each of these has a corresponding **automated** proof with a scripted planner
(the explanation text for never-collected and before-collection, the
`cannot_answer` and `clarify` passthroughs, the SQL shown being the guarded
SQL that ran). What remains unobserved is the model's half: whether
`claude-opus-5` writes SQL the guard accepts, declares the range and points
its SQL reads, and asks rather than guesses.

**To close them:** a working key in `.env.local`, then

```powershell
npm run bas:analyze:verify
```

and paste the output below this line, verbatim.

### What the failed run did verify

The failure was itself an honesty path, and it behaved:

- six questions, six `cannot_answer` results, zero database queries, zero
  crashes;
- six `bas.question_asked` audit rows on the development database, attributed
  to the operator (msheth@phb1899.com), each with `outcome: cannot_answer`;
- six log lines;
- the first run rendered the reason as *could not be reached* — a 401 read as
  a network fault. Corrected: the planner's own words now reach the screen
  (*The model service rejected the API key. Nothing was queried.*). The second
  run shows the corrected wording;
- the first run also hit `audit_events.actor_employee_id` foreign key with the
  script's placeholder viewer. Corrected: the script attributes rows to a real
  employee and says which.

---

## Findings during the build

1. **`pg` used the simple protocol with an empty bind array.** The design
   relied on the extended protocol refusing "two commands in one prepared
   statement" as the fallback for a semicolon the tokenizer missed. With
   `values: []`, node-postgres 8.23 sends a simple Query message, and `DECLARE
   … FOR SELECT 1; SELECT 2` ran both statements — the test that tried it
   resolved with one row instead of rejecting. `queryMode: "extended"` (real
   at runtime, absent from `@types/pg`) forces the Parse message; the test
   now rejects. Recorded in `pool.ts`, `runbook.md`, `WHY` § 52.
2. **`REVOKE TEMP … FROM bas_analyze` does nothing.** `TEMP` is a `PUBLIC`
   grant on the database. The role could still `CREATE TEMP TABLE` after the
   revoke. Revoking from `PUBLIC` would change every role, the collector
   included, so the statement and its proof were removed; the READ ONLY
   transaction refuses `CREATE` (`25006`) and the test pins both halves.
3. **A writing CTE is refused by the cursor, not the grant.** `DECLARE CURSOR
   FOR WITH d AS (DELETE …) SELECT …` → `0A000 feature_not_supported`, before
   READ ONLY (`25006`) or the grant (`42501`) get a say. All three are
   refusals; the test accepts any of the three and asserts nothing changed.
4. **`END` cannot be a refused keyword.** Every `CASE … END` needs it. Caught
   by a test that ran a classification query; the transaction-ending `END` is
   caught by the single-statement rule and the protocol instead.

---

## Build

`npm run build` result: recorded in the pull request description by whoever
merges, after `npm test` has finished — the two spawn Next into `.next`
concurrently otherwise (`runbook.md`).

---

## Not done in this phase

- Production wiring: `ANTHROPIC_API_KEY` and `BAS_ASK_DATABASE_URL` are not in
  `infra/main.bicep`. The `bas_analyze` role does not exist on the Azure
  database. Both are one script and two Key Vault secrets.
- Per-site entitlement: the service refuses outright if `basSiteScope` ever
  returns a list. Written, untested (`docs/testing-blind-spots.md`).
- Server-side refusal fallbacks on the model call: considered, left out (the
  beta client and the honest `cannot_answer` path already exists).
