# Phase 13 — Schedule the Engine, and Notice Silence

Read `CLAUDE.md`, `PHASE-12.md`, and `docs/12-ai-layer-inventory.md` first.

---

## Goal

The containerized engine runs on a schedule in Azure with nobody's laptop involved, and
**a run that doesn't happen gets noticed**.

The second half is the point. This system's characteristic failure is silence — and it
has already happened: both scheduled tasks fired together at 12:26 UTC because the laptop
was off when they were due, and nothing anywhere recorded that the morning runs were
missed. A schedule without absence detection just moves that failure to a different
machine.

---

## Where this sits in the sequence

Phase 13 does not wait for Phase 12 to finish. It **drives** Phase 12 Part E:

```
12 A–D   engine in git, FileStore, container, Claude API   (D blocked on API key)
13       schedule the container against the COPY           ← this phase
12 E     weeks of shadow running on that schedule
14       repoint from copy to live, retire the laptop
```

The scheduling built here is what makes the shadow run happen four times a day without
anyone remembering to trigger it. At cutover, the same job gets repointed — the schedule
itself doesn't change.

**Everything in this phase runs against the copy.** The laptop remains the only thing
touching live, until Phase 14.

## Dependencies

- Azure (Phase 7 Part B deployed)
- Phase 12 Part C — the container exists
- Alerting needs an email destination that is **not one person's address** — a shared
  mailbox or distribution group. Binding alerts to an individual violates the
  no-individual-ownership rule and fails silently when that person leaves.

---

## Part A — The schedule

Two Container Apps Jobs with cron triggers, in the existing environment — one per task,
mirroring what runs today:

| Job | Today (America/New_York) | Runs |
|---|---|---|
| intake-scrub | 07:00 and 12:00, Mon–Fri | the intake engine |
| response-classifier | 08:00 and 13:00, Mon–Fri | the classifier |

Requirements:

- **Verify whether the scheduler supports time zones before writing the crons.** If it's
  UTC-only, the local wall-clock time shifts an hour twice a year with DST. Decide
  deliberately: either accept the shift (the flows trigger on file creation, not on the
  clock, so nothing downstream breaks) or handle it. Whichever way, write the decision
  and the reason in the runbook — an operator seeing a 7 a.m. run land at 8 a.m. in
  November should find the explanation, not a mystery.
- **Preserve the ordering, not just the times.** Intake runs before the classifier on
  purpose. Keep the gap between them whatever happens with time zones.
- **One instance at a time.** Parallelism 1, one completion per execution. If a run is
  still going when the next trigger fires, the new one must not run alongside it — verify
  what the platform actually does in that case rather than assuming, and note that the
  engine's own lock file fails open and coordinates nothing across replicas. The
  scheduler's concurrency setting is the real guard.
- Timeout generous enough for the slowest observed run plus margin, so a slow run
  finishes rather than being killed into a half-written state.
- Job configuration lives in the Bicep with everything else. Nothing clicked together in
  the portal.

## Part B — Noticing failure, and noticing silence

Two different problems, and the second can't be solved from inside the job.

**Failure** — the job ran and exited non-zero. Azure Monitor alert on failed executions,
straight from the job's own telemetry. Every failure alerts; at four runs a day there is
no volume argument for thresholds.

**Silence** — the job didn't run at all. A crashed job can't send its own alert, so this
check lives outside it: a scheduled query against the job's execution history that fires
when an expected window passes with no run. One rule per job, window matched to its
schedule (roughly: no successful run in the last N hours during weekdays).

Requirements:

- **Alert on absence of success, not presence of failure.** A job that hangs forever, or
  never starts, produces no failure event. The absence check is the one that catches the
  class of problem that already happened.
- Alerts go to the shared destination by email. Subject says which job, what happened,
  and when — readable on a phone.
- Every alert points at the runbook entry for that condition.
- **Test both paths deliberately**: force a failing run and confirm the failure alert
  arrives; disable a job for a window and confirm the silence alert arrives. An alert
  rule that has never fired is a hope, not a control.
- The run report the engine already writes stays the human-readable record. Alerts say
  *that* something is wrong; the report says *what happened*.

## Part C — Operations

Runbook entries, written in this phase rather than after:

- A run failed: where the logs are, what the common causes look like, how to re-run once
  safely
- A silence alert fired: how to tell "job disabled" from "job hung" from "environment
  down"
- How to pause the schedule deliberately (and the reminder that pausing the shadow is
  free; pausing after cutover stops the pipeline)
- The DST decision and its reasoning
- What the alerts cost and where the rules live

---

## Out of scope

- **Cutover.** The jobs point at the copy until Phase 14.
- **Retiring the laptop tasks.** They keep running on their current schedule throughout.
- Any change to engine logic, the flows, the sentinel filenames, or the prompts
- **The BAS collector's laptop dependency.** Same problem, tempting to solve with the
  same jobs — but the collector has to reach the JACE over the local network, which Azure
  may not be able to do at all. That's a network question before it's a scheduling one,
  and it belongs to the BAS track. Flag it; don't build it here.
- Dashboards, on-call rotations, paging systems. Email to a shared destination is the
  right size for a four-runs-a-day pipeline.

---

## Hard constraints

- **Nothing in this phase touches the live folders.** Jobs run against the copy only.
- **The laptop tasks are not modified, paused, or rescheduled.**
- **Never two instances against the same tree at once** — enforced by the scheduler's
  concurrency settings, verified, not assumed.
- Alert destination is a group, never an individual.
- All existing tests still pass; platform untouched except Bicep and runbook.

---

## Acceptance criteria

- [ ] Both jobs defined in Bicep, running on schedule against the copy
- [ ] Time-zone behaviour verified, decided, and documented
- [ ] Ordering between intake and classifier preserved
- [ ] Concurrency verified: a second trigger during a running execution does not overlap
- [ ] A forced failure produces an email alert
- [ ] A disabled job produces a silence alert within its window
- [ ] Alerts name the job, the condition, and the runbook entry
- [ ] Alert destination is a shared mailbox or group
- [ ] Runbook entries written for failure, silence, and deliberate pause
- [ ] The laptop tasks ran untouched throughout

---

## Notes for the implementer

**The silence alert is the deliverable.** The failure alert is table stakes; the absence
check is the thing this pipeline has never had and the failure it has already suffered.

**Test the alerts by making them fire.** Both of them. The difference between "configured"
and "works" is exactly the difference this phase exists to close.

**Stop and ask** before anything points at the live tree, before touching either laptop
task, and before any alert routes to an individual.
