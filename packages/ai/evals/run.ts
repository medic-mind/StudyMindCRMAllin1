// Eval harness shared helpers. CLAUDE.md §18.3.
//
// Two modes:
//
// 1. Schema-only (default, runs in CI on every PR via *.test.ts files).
//    Uses a stubbed OpenAI client that returns the recorded `expected.json`
//    directly. The eval asserts the schema parses cleanly. This catches
//    schema regressions without spending tokens.
//
// 2. Live (`pnpm test:ai-live`, nightly only). Uses the real OpenAI client
//    and diffs the live response against `expected.json` per-task. Skipped
//    when OPENAI_API_KEY is not present.

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

export interface FixturePair<I, O> {
  name: string
  input: I
  expected: O
}

export function loadFixtures<I, O>(dir: string): FixturePair<I, O>[] {
  const fixturesDir = join(dir, 'fixtures')
  const files = readdirSync(fixturesDir).filter((f) => f.endsWith('.input.json'))
  return files.sort().map((file) => {
    const name = file.replace('.input.json', '')
    const input = JSON.parse(readFileSync(join(fixturesDir, file), 'utf8')) as I
    const expectedRaw = readFileSync(join(fixturesDir, `${name}.expected.json`), 'utf8')
    const expected = JSON.parse(expectedRaw) as O
    return { name, input, expected }
  })
}

/** True when the live eval should run (nightly CI). */
export function isLiveEvalEnabled(): boolean {
  return Boolean(process.env['OPENAI_API_KEY']) && process.env['AI_EVAL_LIVE'] !== '0'
}
