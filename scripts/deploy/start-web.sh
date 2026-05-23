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
