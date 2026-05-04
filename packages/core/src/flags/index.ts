// Feature flag evaluation. See CLAUDE.md Section 31.
//
// Resolution order:
//   1. Env override   (`FLAG_<UPPER_SNAKE_NAME>=true|false`)
//   2. DB row         (`FeatureFlag` keyed by flag name)
//   3. Registry default
//
// DB results are cached in-memory for 30 seconds per flag name. The cache is
// process-local; this is intentional — Inngest workers and the web service
// each cache independently and converge within the TTL.

import { FLAGS, type FlagName, isFlagName } from './registry'

export type { FlagName, FlagMetadata } from './registry'
export { FLAGS, isFlagName } from './registry'

export interface FlagContext {
  userId?: string
  familyId?: string
}

const CACHE_TTL_MS = 30_000

interface CacheEntry {
  value: boolean
  expiresAt: number
}

// Per-name LRU. The registry has well under 100 flags so a Map is plenty.
const cache = new Map<FlagName, CacheEntry>()

// Pluggable DB reader. Bound at runtime via `bindFlagDbReader` so this module
// stays free of @studymind/db imports — `packages/core` cannot import from
// integrations or persistence layers in production code paths. Apps wire the
// reader at startup; tests can leave it unset to exercise registry+env only.
export type FlagDbReader = (name: FlagName) => Promise<boolean | undefined>

let dbReader: FlagDbReader | undefined

export function bindFlagDbReader(reader: FlagDbReader | undefined): void {
  dbReader = reader
  cache.clear()
}

function envKey(name: FlagName): string {
  return 'FLAG_' + name.toUpperCase().replace(/[^A-Z0-9]+/g, '_')
}

function readEnv(name: FlagName): boolean | undefined {
  const raw = process.env[envKey(name)]
  if (raw === undefined) return undefined
  const v = raw.trim().toLowerCase()
  if (v === 'true' || v === '1') return true
  if (v === 'false' || v === '0') return false
  return undefined
}

function readRegistry(name: FlagName): boolean {
  return FLAGS[name].default
}

/**
 * Evaluate a flag asynchronously: env → DB → registry default.
 * Cached for 30s per flag. The context arg is reserved for per-user/family
 * targeting when we wire it; today it is accepted for API stability.
 */
export async function flag(name: FlagName, _ctx?: FlagContext): Promise<boolean> {
  if (!isFlagName(name)) {
    throw new Error('UNKNOWN_FLAG: ' + String(name))
  }

  const env = readEnv(name)
  if (env !== undefined) return env

  const cached = cache.get(name)
  const now = Date.now()
  if (cached && cached.expiresAt > now) return cached.value

  let value: boolean | undefined
  if (dbReader) {
    try {
      value = await dbReader(name)
    } catch {
      // Fail safe to registry default. Operational kill switches default true,
      // release flags default false; either way we do not throw at call sites.
      value = undefined
    }
  }
  if (value === undefined) value = readRegistry(name)

  cache.set(name, { value, expiresAt: now + CACHE_TTL_MS })
  return value
}

/**
 * Synchronous evaluation for code paths that cannot await (e.g. middleware).
 * Reads env override then falls back to the registry default. Never reads DB.
 */
export function flagSync(name: FlagName): boolean {
  if (!isFlagName(name)) {
    throw new Error('UNKNOWN_FLAG: ' + String(name))
  }
  const env = readEnv(name)
  if (env !== undefined) return env
  return readRegistry(name)
}

export type FlagOverrideScope = 'cache'

/**
 * Test helper: seed the resolution cache with a value and short-circuit DB
 * lookups for the next call. Calling with `undefined` clears the entry.
 */
export function setFlagOverride(
  name: FlagName,
  value: boolean | undefined,
  _scope: FlagOverrideScope = 'cache',
): void {
  if (value === undefined) {
    cache.delete(name)
    return
  }
  cache.set(name, { value, expiresAt: Date.now() + CACHE_TTL_MS })
}

export function clearFlagCache(): void {
  cache.clear()
}
