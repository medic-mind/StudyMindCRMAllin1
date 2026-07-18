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
#
# Then DELETE .next/cache immediately. It is Next's build-time webpack/compiler
# cache (~2.5 GB here) and is NOT needed to serve — `next start` uses only
# .next/server, .next/static and the manifests, and recreates an empty runtime
# cache dir on boot. Left in place it would be copied into the runner image AND
# baked into the per-deploy "apps" layer, so 2.5 GB of throwaway cache got
# re-pushed to Railway on EVERY deploy. Removing it in the same RUN keeps it out
# of every downstream layer. (Railway does not persist this cache across builds
# anyway — there is no cache mount — so deleting it costs nothing.) CLAUDE.md §24.
RUN pnpm --filter web exec next build && rm -rf apps/web/.next/cache

# ---- runner (web) ----
FROM base AS runner
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1
RUN addgroup --system --gid 1001 nodejs && adduser --system --uid 1001 nextjs

# Split the runner into layers by CHANGE FREQUENCY instead of one fat
# `COPY --from=builder /app ./`. That single copy bundled the 1.3 GB
# node_modules WITH the app source, so ANY code edit invalidated the whole
# layer and Railway re-pushed 1.3 GB of unchanged dependencies on every deploy
# — the real reason deploys "took forever".
#
# node_modules is copied FIRST, on its own. Its content is a function of the
# lockfile + a deterministic `prisma generate`, NOT of app code, so on a
# code-only deploy this layer's checksum is unchanged, BuildKit reuses the
# cached layer, and it is never re-pushed. Only the small app/source layers
# below (a few tens of MB, incl. .next) move per deploy.
#
# The boot sequence is unchanged (still `pnpm --filter web start` →
# start-web.sh → migrate/seed/serve), so there is no runtime risk — this is
# purely how the image is layered. CLAUDE.md §24.
COPY --from=builder /app/node_modules ./node_modules
# App source + build output + workspace packages + the manifests pnpm needs to
# resolve `--filter`. Everything the runtime touches; nothing dev-only that the
# current image lacked.
COPY --from=builder /app/apps ./apps
COPY --from=builder /app/packages ./packages
COPY --from=builder /app/scripts ./scripts
COPY --from=builder /app/package.json /app/pnpm-lock.yaml /app/pnpm-workspace.yaml /app/turbo.json /app/tsconfig.base.json ./

USER nextjs
EXPOSE 3000
CMD ["pnpm", "--filter", "web", "start"]
