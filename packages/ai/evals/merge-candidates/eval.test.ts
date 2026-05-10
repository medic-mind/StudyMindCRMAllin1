// Schema-only eval for merge-candidates. CLAUDE.md §18.3.

import { describe, expect, it } from 'vitest'

import {
  buildMergeCandidatesPrompt,
  mergeCandidateSchema,
  type MergeCandidate,
  type MergeCandidatesPromptInput,
} from '../../src/prompts/merge-candidates'
import { loadFixtures } from '../run'

const fixtures = loadFixtures<MergeCandidatesPromptInput, MergeCandidate>(__dirname)

describe('merge-candidates eval (schema)', () => {
  for (const f of fixtures) {
    it(`fixture ${f.name}: schema parses`, () => {
      buildMergeCandidatesPrompt(f.input)
      const parsed = mergeCandidateSchema.parse(f.expected)
      expect(parsed.signals.length).toBeGreaterThanOrEqual(1)
    })
  }
})
