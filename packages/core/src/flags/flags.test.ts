// Flag resolution tests. See CLAUDE.md §31.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  bindFlagDbReader,
  clearFlagCache,
  flag,
  flagSync,
  setFlagOverride,
  type FlagDbReader,
  type FlagName,
} from './index'
import { FLAGS } from './registry'

const FLAG_RELEASE: FlagName = 'ai.draft_replies_enabled' // default false
const FLAG_OPS: FlagName = 'gocardless.late_failure_reversal_enabled' // default true

const ENV_KEY = (n: FlagName) => 'FLAG_' + n.toUpperCase().replace(/[^A-Z0-9]+/g, '_')

beforeEach(() => {
  bindFlagDbReader(undefined)
  clearFlagCache()
  delete process.env[ENV_KEY(FLAG_RELEASE)]
  delete process.env[ENV_KEY(FLAG_OPS)]
})

afterEach(() => {
  bindFlagDbReader(undefined)
  clearFlagCache()
  delete process.env[ENV_KEY(FLAG_RELEASE)]
  delete process.env[ENV_KEY(FLAG_OPS)]
})

describe('flag()', () => {
  it('falls back to registry default when no env or db reader', async () => {
    expect(await flag(FLAG_RELEASE)).toBe(FLAGS[FLAG_RELEASE].default)
    expect(await flag(FLAG_OPS)).toBe(FLAGS[FLAG_OPS].default)
  })

  it('env override beats DB and registry', async () => {
    process.env[ENV_KEY(FLAG_RELEASE)] = 'true'
    const reader: FlagDbReader = async () => false
    bindFlagDbReader(reader)
    expect(await flag(FLAG_RELEASE)).toBe(true)
  })

  it('DB value beats registry default', async () => {
    // release flag's default is false; DB returns true
    bindFlagDbReader(async () => true)
    expect(await flag(FLAG_RELEASE)).toBe(true)
  })

  it('caches DB result for the next call', async () => {
    let calls = 0
    bindFlagDbReader(async () => {
      calls += 1
      return true
    })
    await flag(FLAG_RELEASE)
    await flag(FLAG_RELEASE)
    await flag(FLAG_RELEASE)
    expect(calls).toBe(1)
  })

  it('falls back to registry when DB reader throws', async () => {
    bindFlagDbReader(async () => {
      throw new Error('db down')
    })
    // operational kill switch defaults true — must not flip to false on DB error
    expect(await flag(FLAG_OPS)).toBe(FLAGS[FLAG_OPS].default)
  })

  it('every registered flag resolves', async () => {
    const names = Object.keys(FLAGS) as FlagName[]
    for (const name of names) {
      const value = await flag(name)
      expect(typeof value).toBe('boolean')
    }
  })
})

describe('flagSync()', () => {
  it('reads env override', () => {
    process.env[ENV_KEY(FLAG_OPS)] = 'false'
    expect(flagSync(FLAG_OPS)).toBe(false)
  })

  it('ignores DB reader', () => {
    bindFlagDbReader(async () => true) // DB says true
    // release flag default is false; sync path must not consult DB
    expect(flagSync(FLAG_RELEASE)).toBe(FLAGS[FLAG_RELEASE].default)
  })
})

describe('setFlagOverride', () => {
  it('seeds the cache for tests', async () => {
    setFlagOverride(FLAG_RELEASE, true)
    expect(await flag(FLAG_RELEASE)).toBe(true)
  })

  it('undefined clears the entry', async () => {
    setFlagOverride(FLAG_RELEASE, true)
    setFlagOverride(FLAG_RELEASE, undefined)
    expect(await flag(FLAG_RELEASE)).toBe(FLAGS[FLAG_RELEASE].default)
  })
})
