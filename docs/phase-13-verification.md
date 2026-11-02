# Phase 13 Part B and C — the alerts: what was built, what was verified, what waits

**Status: BUILT 2026-11-02 on `feat/phase-13-alerts-HOLD`, NOT DEPLOYED, NO RULE
HAS FIRED.** The branch is held until Phase 12 Part E (the shadow run) is
complete, by the owner's instruction. Everything below is tagged the
inventory's way: **[observed]** was read from the live resources or run for
real, **[inferred]** is reasoning, **[decision]** is a choice made here or
asked of the owner.

Read first: `docs/PHASE-13.md` → *Part B* and *Part C*;
`docs/phase-12-part-e-plan.md` § 5 (the schedule mechanism Part A became) and
§ 10 (what PHASE-13 gets wrong); `runbook.md` → *Alerts (Phase 13 Part B)*.

---

## 1 · What is built

All in `infra/main.bicep` under *Alerts (Phase 13 Part B)*, behind
`enableAlerts` (default false), plus one job and one script:

| Piece | Resource | What it does |
|---|---|---|
| The destination | `alertActionGroup`, `<baseName>-alerts` | emails `alertContactEmails`; refuses to deploy with the list empty (`fail()`); common alert schema |
| Failure, per job | `jobFailedAlerts`, a loop over `alertFailureJobs` | `PHB job failed - <job>`: the job's execution logged `BackoffLimitExceeded` or `DeadlineExceeded` in the last thirty minutes; evaluated every five; stateless, actions muted thirty minutes |
| Silence, per scheduled job | `jobSilentAlerts`, a loop over `alertSilenceJobs` | `PHB job silent - <job>`: no `Completed` execution inside the lookback while the check band and the weekday say one was due; evaluated every fifteen minutes over a two-day window; stateless, muted six hours |
| The event-driven job's silence | `cipScalerFailedAlert` | `KEDAScalerFailed` from the cip-worker more than `alertCipScalerFailuresPer30Min` times in thirty minutes |
| The database | `dbAliveAlert` (sev 0), `dbStorageAlert` (sev 2) | `is_db_alive` Maximum under 1 for five minutes; `storage_percent` Average over `alertDbStoragePercent` for an hour |
| The web app | `appServerErrorsAlert` (sev 2) | `Requests` with `statusCodeCategory` 5xx, Total over `alertAppServerErrorsPer15Min` in fifteen minutes |
| The BAS collector's alert | `basCollectorCheckJob` + `infra/db-backup/collector-check.sh` | a half-hourly job from the backup image: psql reads `bas_ingest_runs`, exits non-zero when the newest `ok`/`partial` run is older than `basCollectorSilenceMinutes`; its failure rule is the collector's alert, its silence rule is the check's own |

The job lists are built from the same flags that create the jobs
(`enableCipWorker`, `enableDbBackup`, `enableBasCollectorCheck`,
`enableCoShadow`), so no job exists without a failure rule asking after it
and no scheduled job without a silence rule, and
`tests/deploy-guards.test.ts` → *Phase 13 Part B* holds every
`Microsoft.App/jobs` resource in the template to a place in those lists. The
six job names became variables (`cipWorkerJobName` … `coClassifyJobName`) so
a rule can name a job whose resource is not deployed.

Every number a person might change is a parameter: the three metric
thresholds, the scaler threshold, the five silence lookbacks, the four UTC
band hours for the shadow jobs, the check's cron and threshold. The
parameters file carries only the three flags and the address list;
everything else has a default with its reason in the description.

Not built, by decision or by scope: an availability test on the web app
(§ 5); any change to the shadow jobs' crons; anything in `phb-bas`
(`docs/PHASE-13.md` keeps the collector's laptop dependency out of scope, and
this phase adds a watcher, not a mover); dashboards.

---

## 2 · What the live log actually says — the facts the rules rest on

**[observed, 2026-11-02, read-only from the production workspace with
`az monitor log-analytics query` and the Log Analytics REST API.]** Sixty days
of `ContainerAppSystemLogs_CL` for every job that has existed in the
environment (`cip-worker`, and the Part C and Part D by-hand jobs
`co-compare`, `co-step7`, `co-flowprobe`, since deleted):

| Event | `Reason_s` | `Type_s` | `ExecutionName_s` | `Log_s` shape |
|---|---|---|---|---|
| execution finished successfully | `Completed` | Normal | set | `Execution '<name>' for Job '<job>' has successfully completed` — or, on the Part C/D images, `Pod - <pod> has a succeeded container with name: <c>, exit code: 0, and reason: Completed`; both carry `Completed` |
| execution failed, retries exhausted | `BackoffLimitExceeded` | Warning | set | `Job has reached the specified backoff limit` |
| the cause beside it | `OOMKilled` | Warning | set | `… has a failed container … exit code: 137, and reason: OOMKilled` |
| the scaler could not poll | `KEDAScalerFailed` | Warning | empty | `error establishing postgreSQL connection: … connect: connection refused` |
| job-level noise | `SyncingSecretFromAzureKeyVault…`, `KEDAScalingDecision`, `ContainerAppReady`, … | Normal | empty | — |

`DeadlineExceeded` (the replica timeout) was **not** observed - no job has
timed out in this environment - and is in the failure query on the strength
of Microsoft's own troubleshooting post for Container Apps jobs, which
documents it as `Job was active longer than specified deadline`. It is the
one reason string in the rules that is inferred rather than read. **[inferred]**

Cross-checked against the execution history (`az rest` on the job's
`executions`): nine cip-worker executions, seven `Succeeded`, two `Failed`
(`59dgz` on 21 October, `hhjjr` on 22 October) - and the failure query,
rendered from the template and run over thirty days, returned **exactly
those two** and nothing else. **[observed]**

The `Executions` metric on `Microsoft.App/jobs` (with a `state` dimension)
exists and was **not** used for silence: a metric rule does not fire on
missing data, and a job that never ran emits no data point, which is the
case the silence rule exists for. The log query returns one row whatever
happened, so "no rows" can never read as "nothing missed". **[decision]**

---

## 3 · What was verified, and how

**The queries, rendered as the template renders them.** A script read
`jobSilentQuery` and `jobFailedQuery` out of `infra/main.bicep`, substituted
the placeholders the way the `replace()` chain does, and ran each against the
live workspace over a two-day timespan (the rule's `windowSize`). **[observed,
2026-11-02 15:32 UTC, a Monday]**

| Rendered for | `missed` | `completedRuns` | `checkedNow` | Why that is right |
|---|---|---|---|---|
| `db-backup`, 26 h, always | 1 | 0 | true | the backup job does not exist yet; the rule is behind `enableDbBackup` and would not be deployed |
| `co-shadow-feed`, 2 h, 14-23 UTC weekdays | 1 | 0 | true | 15:32 on a Monday is in the band and no feed has ever run |
| `co-shadow-collect`, 8 h, 21-07 UTC weekdays | 0 | 0 | **false** | 15:32 is outside a band that wraps midnight: the wrap logic holds |
| `cip-worker`, 47 h, always | 1 | 0 | true | the last cip execution was 22 October |
| failure query, `cip-worker`, 2 days | — | 0 rows | — | no failure in the window; over 30 days, the two real ones |

**The collector check, for real.** `infra/db-backup/collector-check.sh` run
through the bash and psql on this machine against the test database, with
rows inserted by hand and then by `tests/db-backup-script.test.ts`:
**[observed]**

| State of `bas_ingest_runs` | Threshold | Exit | Log line |
|---|---|---|---|
| empty | 60 | 1 | `BAS COLLECTOR SILENT: no successful collector run is recorded at all (threshold 01:00:00)` |
| one `ok` run finished 4 min ago | 60 | 0 | `BAS collector ok: the last successful run finished at … (00:04:00 ago; threshold 01:00:00)` |
| the same | 3 | 1 | `BAS COLLECTOR SILENT: the last successful run finished at … (00:04:00 ago; threshold 00:03:00); the newest run of any status started at … with status ok` |
| `ok` 2 h ago, `failed` 1 min ago, `running` 30 s ago | 60 | 1 | `… the newest run of any status started at … with status running` |
| a `partial` run 4 min ago | 60 | 0 | ok |
| threshold `abc`, `0`, `-5`, empty, with an unroutable URL | — | 1 | `BAS_COLLECTOR_SILENCE_MINUTES must be a positive integer` before any connection |

**The template.** `az bicep build` and `az bicep lint` clean (Bicep 0.46.1
locally; CI installs the latest). The compiled ARM carries seven
`Microsoft.Insights` resources, every one conditional on `enableAlerts` (the
scaler rule on `enableCipWorker` as well), the two rule families as `copy`
loops over the job lists, and the check job conditional on
`enableBasCollectorCheck` running `[variables('dbBackupImage')]` with the
script path as its whole command. `tests/deploy-guards.test.ts` pins all of
it; `tests/db-backup-script.test.ts` pins the script and runs it.

**The live values the metric thresholds were set against. [observed,
2026-11-02]** `is_db_alive` 1.0 and `storage_percent` 13.3 over the last
day; `Requests` over seven days 1,613 × 200, 1,893 × 302, **146 × 500**, of
which 143 fell in two hours on 26 October during a run of revision restarts
(fifteen `ContainerStarted`, fifty-six `ReplicaUnhealthy` with the readiness
probe refused) while the custom domain was being bound, and 1 + 2 in two
hours on 30 October around a routine rollout. The 5xx threshold of 5 in
fifteen minutes fires on the first and not on the second.

---

## 4 · What has NOT been verified

- **No rule has been deployed, and none has fired.** `docs/PHASE-13.md`'s
  acceptance boxes *A forced failure produces an email alert* and *A disabled
  job produces a silence alert within its window* are **open**. The steps are
  `runbook.md` → *Alerts* → *Testing the alerts*, in order; the first one is
  a half-hour's work once `enableAlerts` is on.
- **The shadow rules have never seen a shadow job.** No shadow job has run
  in Azure (Request 6 pending). The feed and collector bands were written from
  the crons in the Part E section and checked only by the rendered-query runs
  above, which prove the arithmetic and not the schedule. The first weekday
  with the jobs on is the test; a false silence alert on that day is a band
  to correct, not a job to fix.
- **`DeadlineExceeded`** is in the failure query from documentation, not from
  this environment's log (§ 2).
- **The email itself** - subject, body, the link to the rows - has not been
  seen. The common alert schema is documented to put the rule name in the
  subject; the first fired alert confirms or corrects that, and the rule
  names were written to be read on a phone either way.
- **`fail()` on an empty address list** compiles and is in the ARM as a
  conditional expression; whether ARM evaluates it only when the action group
  is deployed (the condition true) is the documented behaviour of conditional
  resources and was not exercised with a deployment.
- **The cost** is list price from third-party summaries; the first bill
  replaces it (`runbook.md` → *What the alerts cost*).

---

## 5 · Decisions

**Made here [decision], each reversible by a parameter or a line:**

1. **Silence is the absence of `Completed`, not the presence of anything
   else** - the one row the query always returns says whether a completed
   execution was due and missing. (`docs/PHASE-13.md` → *Alert on absence of
   success, not presence of failure*.)
2. **One failure rule per job, not one rule for all jobs with a dimension
   split**, so that the email subject names the job as PHASE-13 asks; the
   cost is a rule per job, about fifty cents a month each.
3. **Failure and silence rules are stateless with muted actions** (thirty
   minutes; six hours), so a failure is one email and a silence is a reminder
   four times a day, and neither sends a *Resolved* mail for a job nobody
   fixed. The metric rules are stateful because *the database is back* is
   worth a mail.
4. **The BAS collector's alert is a job whose failure is the alert**, from
   the backup image, because Azure Monitor reads logs and metrics and the
   collector's heartbeat is a table. It runs as the administrator through the
   same `DATABASE-URL` reference the backup holds; nothing about the
   collector or its role changed.
5. **`partial` counts as a run that happened**; Collection Health is where a
   partial run is read.
6. **The job names became variables** in the template, so the rules can name
   a job without reading a resource that may not be deployed; no name
   changed.

**Asked of the owner, not decided:**

1. **The address.** A new M365 group for alerts, or an existing one? The
   template takes a list and refuses an empty one; which address is a decision
   that is a person's, and `alertContactEmails` is blank until it is made.
2. **An availability test on the web app.** The 5xx rule sees errors the
   ingress counted; it cannot see the app returning nothing (environment
   down, a cold start that times out). An Application Insights standard test
   pinging `/api/health` every five minutes would, and would also keep a
   scale-to-zero app warm around the clock - `minReplicas: 0` is a deliberate
   choice in the template, and a warm replica is roughly a dollar a day at
   consumption prices. Not added; one `webtests` resource and one more rule
   if wanted.
3. **The PHASE-13 items that no longer match the Part E plan** - § 6 below -
   which this phase did not resolve, by instruction.

---

## 6 · Where `docs/PHASE-13.md` and the Part E plan disagree

`docs/phase-12-part-e-plan.md` § 10 already lists nine corrections to
PHASE-13. Read against what this part built, the ones a reader of PHASE-13
would act on wrongly, left **unchanged in PHASE-13** for the owner:

| PHASE-13 says | What is true, and where | What this part did |
|---|---|---|
| Part A: *two* Container Apps Jobs, `intake-scrub` at 07:00/12:00 and `response-classifier` at 08:00/13:00, ordered | three jobs, feed/collect/classify, on the Part E plan's crons, with no ordering requirement during the shadow (plan § 5, § 10 items 2 and 5); Part A was delivered by Part E's E5 | wrote the silence rules for the three jobs that exist |
| *At cutover the schedule itself doesn't change* (the sequence diagram) | cutover is a code change, a new image and the repoint, in that order (`docs/PHASE-14.md` 1.2, 3.1); PHASE-13's own paragraph below the diagram already says so, the diagram does not | nothing |
| *12 A–D … (D: key wired 2026-10-01)* | that is the BAS key; Change Orders' key is `CO-ANTHROPIC-API-KEY` since 2026-10-16 and reaches the job, not the web app | nothing |
| Part B: *one rule per job, window matched to its schedule (roughly: no successful run in the last N hours during weekdays)* | built as written, with the window as a lookback plus a check band, because *during weekdays* alone would ask about Sunday on Monday morning | the band parameters, § 1 |
| Part B: *Test both paths deliberately* | not possible before merge and not done | § 4 |
| Part C: *the DST decision* | decided for the window by the Part E plan § 5; PHASE-14 3.5 inherits it | wrote it into the runbook as the window's decision, not a new one |
| *Dependencies: Phase 12 Part C — the container exists* | true, and Part D's image is what the jobs run | nothing |

`docs/PHASE-13.md` itself is not edited on this branch. When it is written up,
§ 10 of the Part E plan and this table are the list.

---

## Related

- `docs/PHASE-13.md` — the specification, with the corrections above beside it
- `docs/phase-12-part-e-plan.md` § 5, § 10, § 15 (*Phase 13 Part B* and *Part
  C* as work done during the window)
- `docs/PHASE-14.md` 0.2, 3.2, 3.5
- `runbook.md` → *Alerts (Phase 13 Part B)*; *Nightly database backup*;
  *Cost Intelligence worker in Azure*; *The change-order shadow run*
- `WHY-ITS-BUILT-THIS-WAY.md` § 77
- `tests/deploy-guards.test.ts` → *Phase 13 Part B*;
  `tests/db-backup-script.test.ts` → *the collector check*
