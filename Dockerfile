# syntax=docker/dockerfile:1.7

# ---- base ----
FROM node:20-alpine AS base
RUN apk add --no-cache libc6-compat openssl
WORKDIR /app
ENV PNPM_HOME=/usr/local/share/pnpm \
    PATH=/usr/local/share/pnpm:$PATH
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate

# ---- manifests ----
# Isolate just the workspace package.json files. This stage re-runs on every
# source change (cheap: copy + delete), but its OUTPUT only changes when a
# manifest changes — so the expensive `pnpm install` layer in `deps` below
# stays cached across ordinary code-only deploys.
#
# (The previous layout copied all source into the SAME stage as the install:
# the COPY layer's cache key covered every source file, so any commit
# invalidated it and every deploy re-installed all dependencies from scratch
# — the main reason deploys crawled.)
FROM base AS manifests
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml* ./
COPY turbo.json tsconfig.base.json ./
COPY apps ./apps
COPY packages ./packages
RUN find apps packages -mindepth 2 -type f ! -name package.json -delete \
 && find apps packages -depth -mindepth 2 -type d -empty -delete

# ---- deps ----
FROM base AS deps
# Cache key = content of the manifests-only tree, NOT the full source tree.
COPY --from=manifests /app ./
RUN pnpm install --frozen-lockfile || pnpm install

# ---- builder ----
FROM base AS builder
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# Re-run install so per-package node_modules symlink farms are recreated against
# the full source tree (the deps stage stripped non-manifest files, so the per-
# package .bin directories were never materialised). pnpm is fast on cache hit.
RUN pnpm install --frozen-lockfile --offline || pnpm install --frozen-lockfile
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
# directly) and roughly doubles-to-triples deploy time on a cold Docker
# cache. CI on main is the verification gate (§24.1); the deploy build's
# only job is producing .next.
# (A BuildKit `--mount=type=cache` for Next's compiler cache was tried but
# Railway's Metal builder rejects the cache-mount id syntax. The real deploy
# speedup is the deps-layer caching above; this step just produces .next.)
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
