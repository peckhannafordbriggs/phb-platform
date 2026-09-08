# B7 — Settings tab, project hierarchy, and UI-managed stations

**Written:** 8 September 2026
**Status:** designed, not started
**Prerequisite:** none — this is buildable today, with synthetic data

---

## What this is

A fourth tab in the Building Automation module, alongside Collection Health,
Point Explorer and the future chat tab.

Today, adding a building means editing a config file on the collector host and
inserting rows by hand. After B7, it is a form. That is the difference between
*"Mahi adds buildings"* and *"the company adds buildings"* — which matters
directly, because the current developer leaves in December 2026.

It also introduces a level the schema does not have yet: **Project**.

---

## The hierarchy

```
Organisation            PH+B
  └── Project           Liberty Center, Kenwood Mall
       └── Building     North Building, Parking Structure
            └── Station a JACE (or a Supervisor)
                 └── Point
                      └── Reading
```

**Why a real level and not a label.** Building ↔ JACE is *not* 1:1 in either
direction — a large building can have two JACEs in separate mechanical rooms,
and one JACE can serve several small buildings on a strip. Collapsing them
works until the first exception and then requires a migration against live
data. A label on a flat list also cannot answer "compare the two Liberty
Center buildings" in SQL without string matching.

`bas_sites` already means "a building," so the change is to insert
`bas_projects` above it rather than to redefine anything.

---

## Decisions (8 September)

| # | Decision | Reason |
|---|---|---|
| **D11** | Org → Project → Building → Station. Fixed depth, not a self-referencing tree. | Explicit levels are far easier to query, to render in a two-step filter, and for the eventual AI to reason about. Arbitrary-depth trees are painful in analytics SQL. |
| **D12** | **Collection is via a central station.** Other JACEs are linked in Niagara Workbench over the NiagaraNetwork; their histories appear on the central station. Our UI does not connect to them. | Direct oBIX to each JACE requires installing `obixDriver-rt` and **commissioning — a full firmware upgrade with downtime — on every production JACE.** That does not scale, and the central-collector plan exists to avoid it. |
| **D13** | Credentials are stored in the platform, encrypted, and are **write-only** through the API. | A config file on the collector host works at 3 stations and fails at 30. It also defeats the feature: if adding a building still means logging into the collector box, nothing moved to the UI. |
| **D14** | A **separate admin grant** controls create/edit. BAS access alone is view-only. | Viewing data and changing what gets collected are different privileges. A misconfigured station silently stops collection, and silent is the failure mode this project keeps paying for. |
| **D15** | **Reverses part of D1.** The collector will read its station list and credentials from the database, not from its config file. | This is what makes the Settings tab real rather than decorative. Cost: the collector now needs the same encryption key as the platform — two places, one secret. |

### Credential count — smaller than it looks

Because of D12, the number of stored credentials is **one per collection
endpoint**, not one per JACE. 600 JACEs linked in Workbench behind a handful of
central stations or Supervisors means perhaps 10–50 credentials. Still far too
many for a config file; nowhere near 600.

---

## Credential handling — the part that is easy to get wrong

**Own table, `bas_station_credentials`**, separate from `bas_stations`.
Separation is not cosmetic: it means `bas_readonly_platform` (Grafana, the MCP
server, the AI's SQL tool) can be denied the credentials table entirely while
still reading everything else. This matches the existing table-by-table grant
discipline.

| Rule | Detail |
|---|---|
| **Encrypted at rest** | AES-256-GCM. Key from the environment (`BAS_CREDENTIAL_KEY`), **never** stored in the database beside the ciphertext. `key_version` column so rotation is possible later without a flag day. |
| **Write-only through the API** | No endpoint ever returns a password. `GET` returns `{ username, passwordSet: true, passwordUpdatedAt }`. The form renders `••••• (set 14 Aug)` and a **Replace** button. |
| **Never logged** | Not in logs, not in error messages, not in audit event payloads, not in exception traces. |
| **Audited** | `bas.station_credential_updated` records station and actor. Never the value. |
| **Lazy, like `GRAPH_*`** | A missing `BAS_CREDENTIAL_KEY` disables credential management and nothing else. It must not stop the platform booting. |

**Migration path:** the shared-key approach is the pragmatic answer while Azure
permissions are unresolved. Azure Key Vault is the proper destination — platform
writes, collector reads — and `key_version` is what makes that move possible
later.

---

## The first rows — real, not placeholder

The backfill creates exactly one of each, matching what actually exists:

| Level | Value |
|---|---|
| Project | **Peck Hannaford + Briggs** |
| Building | **Spring Grove** |
| Station | the existing lab station |

The station's Niagara name is **`SpringGroveLabComputer`** — case-sensitive, and
it appears literally in every oBIX URL. It must not be renamed, retitled or
normalised. A friendlier display name is fine as a separate field; the Niagara
name stays byte-for-byte. `connection_mode` is `direct`, `base_url` is
`https://196.1.1.213/`.

**No invented example projects or buildings.** This project has a standing rule
against plausible-looking fake data: `Temp1`–`Temp3` are deliberately left
unclassified because nobody knows what they represent, and giving them a
made-up role would make the AI answer confidently about something untrue. A
fake "Liberty Center" row is the same mistake — someone eventually sees it in a
dropdown and believes it.

**Note on ownership:** the lab station physically sits at Spring Grove, but its
licence belongs to **Building Controls & Solutions** under a Columbus
Temperature Controls project. Where it sits and who owns it are different
facts, and documentation should not blur them.

---

## Build phases

Nothing starts before the previous phase is demonstrably done. Negative tests
are mandatory for anything touching authorization.

### B7.1 — Schema

`bas_projects` table. `bas_sites` gains `project_id`. `bas_stations` gains
`connection_mode` (`direct` | `via_parent`) and `base_url` (nullable, only
meaningful for `direct`). New `bas_station_credentials` table. Backfill as
above.

**Done when:** migration applies to a fresh database with `ON_ERROR_STOP=1`,
`prisma generate` succeeds, the full suite still passes, and
`migrate dev --create-only` produces an empty migration — zero drift.

### B7.2 — Settings tab, read-only

The tab, the new admin grant, and a read-only tree of projects → buildings →
stations. Behind `withBas` plus the admin check.

**Done when:** a BAS user without the admin grant gets **404, not 403**, on
both the page and every settings API route. That negative test is the point of
the phase.

### B7.3 — Create and edit projects and buildings

Forms, validation, audit events.

### B7.4 — Register a station

Connection mode, IP or parent station, and credentials — write-only, encrypted,
never returned.

**Done when:** a password can be set and used, and no code path anywhere
returns it. Prove it with a test that walks every settings route and fails on
any response containing either the ciphertext or the plaintext.

### B7.5 — Collector reads its targets from the database

The D15 change. The config file becomes a fallback, then retires.

**Done when:** a station added entirely through the UI is collected on the next
cycle, with no file edited and nobody logged into the collector host.

### B7.6 — Two-level filter

The existing building dropdown becomes project → building. Both in the URL,
both filtered in the `WHERE` clause, both intersected with entitlements.

---

## Risks

**The shared encryption key.** Two systems, one secret, and it must exist on
the collector host and in the platform. Getting it out of sync means the
collector cannot decrypt and collection stops — which, against a 41.7-hour roll
horizon, destroys data. This needs a loud, specific error, not a generic
connection failure.

**Scale beyond the current ceiling.** The lab station caps at 1,250 points and
26 devices. 600 JACEs implies multiple Supervisors, which is a purchase
decision nobody owns. The schema handles it (`parent_station_id` is already
nullable and self-referencing); the licensing does not.

**Config drift between UI and Workbench.** A JACE linked in Workbench but never
labelled in our UI will collect data with no project or building attached.
Settings should show these as "discovered, unassigned" rather than hiding them.
