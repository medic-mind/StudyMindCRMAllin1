#!/bin/sh
# Fallback start script for Railpack when railway.json's DOCKERFILE builder isn't honoured.
# Real production uses the Dockerfile + railway.json. This is here so a Railpack
# auto-detect doesn't fail with "Script start.sh not found".
set -e

if [ -d node_modules ]; then
  : # deps installed
else
  corepack enable
  corepack prepare pnpm@9.12.0 --activate
  pnpm install --frozen-lockfile
fi

pnpm --filter @studymind/db prisma migrate deploy
exec pnpm --filter web start
