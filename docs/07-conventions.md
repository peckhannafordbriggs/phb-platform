# Conventions

## API

Consistent response and error shapes across all routes.

```
success:  { data: <T> }
error:    { error: { code: string, message: string } }
```

Status codes: `401` unauthenticated, `403` authenticated but forbidden action, `404`
missing module grant or missing resource, `422` validation, `500` unexpected.

The frontend asks for domain concepts ("the change-order inbox"), never Microsoft
internals. All integration complexity stays in the backend.

Validate every input at the boundary with a schema (Zod). Never trust a client-supplied
employee ID, role, or permission.

## Errors

External integrations fail. Handle Graph errors, expired credentials, permission
failures, rate limiting, database failures, network failures.

- Never swallow an error silently.
- Never return a raw backend error or stack trace to the browser.
- User-facing messages are useful and non-technical; server-side diagnostics are
  detailed.

## Logging

Structured logs. Include: request ID, employee ID, route, outcome, duration.

**Never log:** message bodies, attachment content, access or refresh tokens, secrets,
API keys, recipient lists in full.

Log enough to diagnose a failure without leaking content.

## Secrets

Never commit. Never hardcode. Use environment configuration locally and Key Vault in
Azure.

Provide `.env.example` with every variable named and no real values.

Variables in use today:

```
DATABASE_URL
AUTH_SECRET
AUTH_URL
AUTH_MICROSOFT_ENTRA_ID_ID
AUTH_MICROSOFT_ENTRA_ID_SECRET        # local dev only
AUTH_MICROSOFT_ENTRA_ID_TENANT_ID
ALLOWED_EMAIL_DOMAINS                 # comma-separated
BOOTSTRAP_ADMIN_EMAIL                 # comma-separated
PHB_ALLOW_SEND=false                  # enforced in the mail service, must stay false

GRAPH_CLIENT_ID                       # Graph app registration, separate from SSO
GRAPH_CLIENT_SECRET                   # local dev only; refused in production
GRAPH_TENANT_ID
GRAPH_MANAGED_IDENTITY_CLIENT_ID      # Azure only, optional
CO_MAILBOX                            # the only mailbox the platform may touch
```

The `GRAPH_*` and `CO_MAILBOX` variables are **not** validated at boot. The platform
must start and serve every other screen with no Graph credential configured, so they
are checked lazily when the mail service is first used.

## Environments

Local, staging, production do not share configuration. Never hardcode URLs, database
locations, tenant configuration, credentials, or callback URLs.

## Code

Prefer: small focused functions, clear names, explicit types, reusable services,
framework conventions, comments explaining *why*.

Avoid: giant files, unnecessary abstraction layers, duplicated business logic, magic
constants, hidden side effects, hardcoded environment assumptions.

Do not introduce microservices, event buses, Kubernetes, custom auth, custom email
infrastructure, workflow engines, or plugin frameworks. If a task seems to require one,
stop and ask.

## Definition of done

A phase is not complete because code exists. Completion is demonstrated behavior.

Every phase has explicit acceptance criteria, each one verifiable. Automated where
possible; where manual, document what was done and what was observed.

Include **negative tests**. For authorization especially, the test that matters is
that an ungranted request is rejected — not that a granted one succeeds.

## Runbook

`runbook.md`, written during each phase, not after. For every new failure mode:

- What the symptom looks like to a user
- What causes it
- How to fix it
- What expires and when, if anything

Assume the reader has never seen this codebase.

## Idempotency

Never assume a scheduled job runs exactly once. Where duplication is dangerous —
duplicate drafts, repeated flow triggers, double sends — design for it explicitly.
Relevant once the platform can send mail and run scheduled jobs.
