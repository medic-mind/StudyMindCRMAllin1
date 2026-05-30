#!/bin/sh
# Railway start script for the `web` service.
# Logs each step so the deploy log actually tells us where startup fails.
# Without this wrapper, if migrate or seed hangs/crashes silently, the
# deploy log goes blank and the only signal is the eventual healthcheck
# failure with "service unavailable" — useless for diagnosis.
set -e

PORT="${PORT:-3000}"
HOST="0.0.0.0"

echo "[start] $(date -u +%FT%TZ) boot"
echo "[start] node $(node -v)"
echo "[start] pnpm $(pnpm -v)"
echo "[start] PORT=${PORT} HOST=${HOST}"
echo "[start] DATABASE_URL set: $([ -n \"${DATABASE_URL:-}\" ] && echo yes || echo NO)"
echo "[start] AUTH_SECRET set: $([ -n \"${AUTH_SECRET:-}\" ] && echo yes || echo NO)"

# Self-heal: when a migration aborts (typically a constraint violation),
# Prisma marks it as FAILED in `_prisma_migrations` and refuses to apply
# any further migrations until an operator runs `prisma migrate resolve`.
# Failed migrations were rolled back by Prisma (it wraps each in a
# transaction), so their `_prisma_migrations` row is the only state left —
# clear that row and `migrate deploy` will retry on this boot with
# whatever SQL is now in the file.
#
# The WHERE clause matches only failed rows: applied rows have finished_at
# SET, manually-rolled-back rows have rolled_back_at SET, in-flight rows
# only exist during a `migrate deploy` run (and we just exited that one).
echo "[start] clearing FAILED prisma migration markers (if any)..."
printf 'DELETE FROM "_prisma_migrations" WHERE finished_at IS NULL AND rolled_back_at IS NULL;\n' \
  | pnpm --filter @studymind/db exec prisma db execute --stdin --schema prisma/schema.prisma \
  || echo "[start] (self-heal step failed, likely first boot — continuing)"

echo "[start] running prisma migrate deploy..."
if ! pnpm --filter @studymind/db exec prisma migrate deploy; then
  echo "[start] FATAL: prisma migrate deploy failed. Container will exit."
  exit 1
fi
echo "[start] migrations applied."

echo "[start] running super-admin seed (idempotent, non-blocking)..."
if pnpm seed:super-admin; then
  echo "[start] seed ok."
else
  echo "[start] seed failed (continuing). Inspect log above for the verification URL."
fi

echo "[start] starting next on ${HOST}:${PORT}..."
exec pnpm --filter web exec next start --hostname "${HOST}" --port "${PORT}"
