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
COPY apps/web/package.json ./apps/web/
COPY packages/db/package.json ./packages/db/
COPY packages/core/package.json ./packages/core/
COPY packages/audit/package.json ./packages/audit/
COPY packages/ai/package.json ./packages/ai/
COPY packages/jobs/package.json ./packages/jobs/
COPY packages/ui/package.json ./packages/ui/
COPY packages/integrations/stripe/package.json ./packages/integrations/stripe/
COPY packages/integrations/gocardless/package.json ./packages/integrations/gocardless/
COPY packages/integrations/aircall/package.json ./packages/integrations/aircall/
COPY packages/integrations/trengo/package.json ./packages/integrations/trengo/
COPY packages/integrations/slack/package.json ./packages/integrations/slack/
COPY packages/integrations/asana/package.json ./packages/integrations/asana/
COPY packages/integrations/gmail/package.json ./packages/integrations/gmail/
COPY packages/integrations/booking/package.json ./packages/integrations/booking/
RUN pnpm install --frozen-lockfile || pnpm install

# ---- builder ----
FROM base AS builder
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN pnpm --filter @studymind/db prisma generate
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
