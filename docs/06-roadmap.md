# Roadmap

## Constraint

The current operator leaves **December 2026** and no successor has been confirmed.
Everything below is shaped by that. The MVP must be a defensible stopping point, not
a half-finished migration.

---

## In scope before December

### Phase 1 — Platform foundation
Shell, Entra SSO with the full login gate, self-provisioning, onboarding, employees /
grants / audit schema, authorization middleware, admin screen.

No Graph. No Claude. Full spec: `PHASE-1.md`.

*Why auth is in Phase 1:* SSO configuration is the riskiest unknown and roughly a
day's work. Discovering redirect-URI or guest-filtering problems in week one is much
cheaper than in week five. A shell without auth is also not demonstrable to anyone.

### Phase 2 — Graph connection and read-only mailbox
App-only Graph auth, mail service boundary, folder tree with nesting, message list,
message read with sanitized HTML, attachments, search.

Read-only ships first because the worst possible bug is showing nothing.

Requires: the completed IT request (app registration, admin consent, verified
ApplicationAccessPolicy scoping).

### Phase 3 — Drafts
Open, edit, autosave, send. `PHB_ALLOW_SEND` and `ZZTEST` guards in place.

This is the actual daily human job and the highest-value part of the whole platform.

### Phase 4 — Deploy and hand over
Azure deployment from CI, Key Vault, managed identity + federated credential,
`docs/runbook.md` complete, handover documentation.

**Phases 1–4 are the MVP.** They are enough to stop and be useful.

---

## Not before 2027 — requires a named owner

Do not begin any of these. Listing them is scope definition, not a plan.

- **Full email actions** — compose from scratch, reply / reply-all / forward, move,
  delete, attachment add/remove.
- **CO context panel** — linking a draft to its `co_key`, run report, and Q&A log.
  The most attractive feature and the one with no Outlook fallback. Deliberately cut.
- **Graph change notifications** — subscriptions, renewal, reconciliation.
- **Message index / caching layer** — only if performance demands it.
- **Centralizing the AI layer** — moving the scheduled tasks off the laptop, the
  Claude API migration, prompt management.
- **Centralized scheduling** — background jobs, heartbeats, alerting.
- **Additional modules.**

### On the AI layer specifically

Leaving mid-migration on the AI layer is the worst possible handover state. The
current pipeline works. Moving it requires: extracting a file-access interface from
`run_workflow.py`, containerizing it, shadow-running against a copy for weeks,
diffing outputs, then cutting over.

**Do not start this before December under any circumstances.**

A separate, much smaller step is worth doing independently of the platform: move the
two scheduled tasks from a personal laptop to an always-on host. Zero code change,
removes the single point of failure. That is an operations task, not a platform phase.

---

## Migration principle

```
Existing working system
    ↓
Build the platform beside it
    ↓
Prove the employee workflow
    ↓
(later, with an owner) integrate automation
    ↓
(later still) centralize AI
```

No big-bang rewrite. At every point, the Outlook path still works.
