# syntax=docker/dockerfile:1.7

# ---- base ----
FROM node:20-alpine AS base
RUN apk add --no-cache libc6-compat openssl
WORKDIR /app
ENV PNPM_HOME=/usr/local/share/pnpm \
    PATH=/usr/local/share/pnpm:$PATH
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate

# ---- deps (fetch) ----
# `pnpm fetch` downloads every dependency into the virtual store from the
# LOCKFILE ALONE — no package.json files, no source. So this layer's cache key
# is just pnpm-lock.yaml: it is reused on EVERY code-only deploy and only
# re-runs when the lockfile changes. This replaces the old two-full-installs +
# manifest-stripping dance (deps installed once, builder installed AGAIN) that
# made Railway re-download the whole dependency tree on ordinary deploys.
FROM base AS deps
COPY pnpm-lock.yaml ./
RUN pnpm fetch

# ---- builder ----
FROM base AS builder
# Bring in the pre-fetched store, then LINK it against the real source with
# --offline (no network) — a fast pass, not a second download.
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN pnpm install --frozen-lockfile --offline
RUN pnpm --filter @studymind/db exec prisma generate
# Build-time-only placeholder. NextAuth (Auth.js v5) reads AUTH_SECRET at
# import time when its `auth()` is initialised; without it the build can
# crash before runtime env vars from Railway are applied. The value here
# has no effect at runtime — Railway env overrides it when the container
# actually serves traffic. ADR 0010 chunk 3.
ENV AUTH_SECRET=build-placeholder-not-for-runtime \
    SKIP_ENV_VALIDATION=1
# Build ONLY the Next.js app. `pnpm build` (turbo run build) would re-run
# `tsc --noEmit` across every workspace package — pure re-verification that
# produces no artifact the app needs (Next transpiles workspace TS sources
# directly). CI on main is the verification gate (§24.1); the deploy build's
# only job is producing .next.
RUN pnpm --filter web exec next build

# ---- runner (web) ----
FROM base AS runner
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1
RUN addgroup --system --gid 1001 nodejs && adduser --system --uid 1001 nextjs
COPY --from=builder /app ./
USER nextjs
EXPOSE 3000
CMD ["pnpm", "--filter", "web", "start"]
