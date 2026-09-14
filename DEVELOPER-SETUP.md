# Getting set up on the PHB platform

Everything you need to get the platform running on your machine and start building.
Should take about an hour, most of it waiting on installs.

---

## What you're setting up

The platform is a Next.js app with a PostgreSQL database. You'll run both locally. Sign-in
goes to Microsoft with your real PH+B account, so you log in as yourself — there are no
test accounts and no passwords stored anywhere.

Your module will live in this same repo alongside Change Orders and Building Automation.

---

## 1 · Install what you need

- **Node.js 20 or newer** — `node --version` to check
- **PostgreSQL 16 or newer** — the installer will ask you to set a password for the
  `postgres` user. Write it down, you'll need it in step 3
- **Git**

## 2 · Clone the repo

```bash
git clone https://github.com/peckhannafordbriggs/phb-platform.git
cd phb-platform
npm install
```

## 3 · Create your databases

Two of them — one for development, one that the test suite wipes between runs.

```bash
createdb phb_platform
```

The test database is created for you in step 5.

## 4 · Write your `.env.local`

Copy `.env.example` to `.env.local`, then fill it in. **`runbook.md` has a full section on
this** — *"Filling in `.env.local` on a new machine"* — which says exactly where each value
comes from. Short version:

**You generate these yourself:**

| Variable | What to put |
|---|---|
| `DATABASE_URL` | `postgresql://postgres:YOURPASSWORD@localhost:5432/phb_platform` |
| `TEST_DATABASE_URL` | Same but ending `/phb_platform_test` |
| `AUTH_SECRET` | Run `npx auth secret` — yours alone, doesn't need to match anyone's |
| `AUTH_URL` | `http://localhost:3000` |
| `BOOTSTRAP_ADMIN_EMAIL` | `krachamolla@phb1899.com` — this makes you admin on your own machine |
| `ALLOWED_EMAIL_DOMAINS` | `phb1899.com` |
| `PHB_ALLOW_SEND` | `false` — leave it false, see the warning below |
| `CO_MAILBOX` | `changeorder@phb1899.com` |

**Ask Mahi for these** — they're the same for everyone, they're just not in the repo:

- `AUTH_MICROSOFT_ENTRA_ID_ID` (client ID, not secret)
- `AUTH_MICROSOFT_ENTRA_ID_TENANT_ID`
- `AUTH_MICROSOFT_ENTRA_ID_SECRET` — get this over Teams, not email

The `GRAPH_*` variables are only needed if you're working on the Change Orders mailbox.
Leave them empty otherwise — the app runs fine without them and that module just reports
itself as not configured.

## 5 · Set up the database

```bash
npx prisma migrate deploy      # creates the tables
npm run db:test:setup          # creates and migrates the test database
npm run seed                   # departments, positions, modules, your admin row
npm run seed:dev               # 130 fake employees so lists and filters have volume
```

## 6 · Run it

```bash
npm run dev
```

Open `http://localhost:3000`, sign in with your PH+B account, complete your profile.

You should land on Home as an admin. Go to Admin, find yourself, and toggle on whichever
modules you want to look at.

## 7 · Check the tests pass

```bash
npm test
```

Around 1,270 of them, against your real test database. If they pass, you're set up
correctly.

---

## Before you start building

**Read `WHY-ITS-BUILT-THIS-WAY.md`.** It's the reasoning behind every design decision in
here. Most of what looks odd is odd for a reason, and the document says which.

`PLATFORM-CONTEXT.md` covers what the platform already provides — auth, employees, grants,
the admin screen — so you don't rebuild any of it, plus the four-part contract a new module
has to satisfy.

`CLAUDE.md` is the short version of the rules.

---

## Things that will bite you if nobody tells you

**Your local app talks to the real change-order mailbox.** There is no test mailbox. Two
guards protect it: `PHB_ALLOW_SEND` must be `true` for anything to send, and outside
production the app will only modify messages whose subject starts with `ZZTEST`. Leave both
alone. If you need to test something in the mailbox, make a draft in Outlook with a
`ZZTEST` subject.

**Never write `Bid Tracker.xlsx` from code**, and never write these four filenames
anywhere: `scrub_result.json`, `vendor_drafts.json`, `transfer_ready.json`,
`classification_result.json`. They're live triggers for Power Automate flows that run the
change-order process daily.

**The SharePoint path is misspelled** — `CO Managment Process`, one A. Eleven flows depend
on the exact string. Don't fix it.

**Nothing sends email automatically, ever.** Every outbound message is a draft a human
reads and sends. Don't build bulk send, send-all, multi-select send, or anything that sends
more than one message per click.

**The database schema is shared.** Your tables live in the same `prisma/schema.prisma` and
the same migration history as everything else, so a broken migration blocks the whole
platform's deploy. Prefix your tables consistently — Building Automation uses `bas_`.

---

## How we're working in the repo

Branch, commit, open a pull request. Mahi reviews and merges. Nothing goes straight to
`main` — the platform is running change orders and building automation data now, so changes
get a second pair of eyes.

CI runs the full test suite on every push. A failing test in your branch blocks your PR;
a failing test on `main` blocks everyone's deploy.

---

## If something doesn't work

`runbook.md` is organized by symptom — find what you're seeing, it'll say what causes it
and what to do. The sign-in failures in particular have unhelpful error messages, and the
runbook translates them.

If it's not in there, ask.
