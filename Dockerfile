# PHB Platform production image.
#
# Three stages: dependencies, build, runtime. Only the third is shipped.
#
# ---------------------------------------------------------------------------
# A note on Prisma, because the usual advice does not apply to this project
# ---------------------------------------------------------------------------
# The classic container failure is a native Prisma query engine built for one
# libc running on another - a Debian engine on Alpine - which fails at runtime
# with an unhelpful error rather than at build time.
#
# This project cannot hit that. It uses Prisma 7's `prisma-client` generator with
# the `@prisma/adapter-pg` driver adapter, so queries are compiled by WebAssembly
# embedded in @prisma/client/runtime as base64 JavaScript. Verify it yourself:
#
#   ls node_modules/@prisma/client/runtime | grep query_compiler
#   find lib/generated/prisma -name '*.node' -o -name '*.so*'   # finds nothing
#
# There is no native query engine to mismatch, so `binaryTargets` would do
# nothing here and openssl is not a runtime requirement.
#
# What IS platform-specific is the *schema* engine in @prisma/engines, used by
# `prisma migrate deploy`. It is not in this image, and migrations deliberately
# do not run here - see .github/workflows/deploy.yml and docs/runbook.md. Every
# replica running migrations on start is a race.
#
# Debian slim rather than Alpine anyway: Next.js pulls in prebuilt native
# binaries (sharp) for which glibc is the well-trodden path, and the size
# difference does not pay for the debugging.

ARG NODE_VERSION=24-bookworm-slim

# ---------------------------------------------------------------------------
# Stage 1 - dependencies. Cached on the lockfile alone.
# ---------------------------------------------------------------------------
FROM node:${NODE_VERSION} AS deps

WORKDIR /app

# npm 11 refuses install scripts unless approved, and package.json pins the
# approvals under "allowScripts". Copying both files means that stays true here.
COPY package.json package-lock.json ./

# `npm ci` deletes node_modules and installs exactly the lockfile. Never
# `npm install` in an image: it can resolve a different tree than CI tested.
RUN npm ci

# ---------------------------------------------------------------------------
# Stage 2 - build.
# ---------------------------------------------------------------------------
FROM node:${NODE_VERSION} AS build

WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# lib/generated is gitignored and excluded by .dockerignore, so the client is
# generated here. It has to exist before `next build` traces the import graph,
# or the build fails on an unresolved module.
RUN npx prisma generate

# Values needed only so the build can import lib/env.ts, which parses the
# environment at module load. They are placeholders, they are not secrets, and
# nothing reads them at runtime - the container app supplies the real values.
# DATABASE_URL is never connected to during a build: every route is
# force-dynamic, so no page is prerendered against a database.
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    DATABASE_URL=postgresql://build:build@127.0.0.1:5432/build \
    AUTH_SECRET=build-time-placeholder-not-a-secret \
    AUTH_MICROSOFT_ENTRA_ID_ID=00000000-0000-0000-0000-000000000000 \
    AUTH_MICROSOFT_ENTRA_ID_TENANT_ID=00000000-0000-0000-0000-000000000000 \
    ALLOWED_EMAIL_DOMAINS=example.invalid

RUN npm run build

# ---------------------------------------------------------------------------
# Stage 3 - runtime. Nothing from the build toolchain reaches this stage.
# ---------------------------------------------------------------------------
FROM node:${NODE_VERSION} AS runtime

WORKDIR /app

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0

# Non-root. The node image already ships an unprivileged `node` user (uid 1000),
# so there is no useradd here and no uid to keep in sync with anything.
USER node

# `output: "standalone"` produced a self-contained server.js plus only the
# node_modules the traced graph reaches. Copying that rather than running a
# second install is what keeps the image small and its contents a consequence of
# the build.
COPY --from=build --chown=node:node /app/.next/standalone ./
# Static assets are not part of the standalone bundle and have to be placed at
# the path the server expects.
COPY --from=build --chown=node:node /app/.next/static ./.next/static

EXPOSE 3000

# No shell form, so node is PID 1 and receives SIGTERM directly. With a shell
# wrapper the signal goes to sh and the container is killed on the timeout
# instead of shutting down.
CMD ["node", "server.js"]
