# syntax=docker/dockerfile:1.7

# ---- base ----
FROM node:20-alpine AS base
RUN apk add --no-cache libc6-compat openssl
WORKDIR /app
ENV PNPM_HOME=/usr/local/share/pnpm \
    PATH=/usr/local/share/pnpm:$PATH
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate

# ---- deps ----
FROM base AS deps
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml* ./
COPY turbo.json tsconfig.base.json ./
# Copy every workspace package.json without enumerating each so the Dockerfile
# stays stable as new packages land. We strip non-manifest files after the COPY
# to keep the deps layer cache hot when source code changes.
COPY apps ./apps
COPY packages ./packages
RUN find apps packages -mindepth 2 -type f ! -name package.json -delete \
 && find apps packages -depth -mindepth 2 -type d -empty -delete
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
# Build-time-only placeholder keys. ClerkProvider initialises at module-load
# time during static generation; without a key Next's build crashes before
# runtime env vars from Railway get a chance. These are PUBLISHABLE / DUMMY
# values — they have no effect at runtime because Railway env overrides them
# when the container actually serves traffic.
ENV NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_test_d29ya2Jvb2staGVyYWxkLTk0LmNsZXJrLmFjY291bnRzLmRldiQ \
    CLERK_SECRET_KEY=sk_test_BUILD_PLACEHOLDER \
    SKIP_ENV_VALIDATION=1
RUN pnpm build

# ---- runner (web) ----
FROM base AS runner
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1
RUN addgroup --system --gid 1001 nodejs && adduser --system --uid 1001 nextjs
COPY --from=builder /app ./
USER nextjs
EXPOSE 3000
CMD ["pnpm", "--filter", "web", "start"]
