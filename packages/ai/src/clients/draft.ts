// Drafting OpenAI client wrapper. Free-text output, validated post-hoc.
// See CLAUDE.md Section 18.1.

import { z } from 'zod'

export interface DraftCallOptions {
  task: string
  promptVersion: string
  model: 'gpt-4o'
  system: string
  user: string
  temperature?: number
  shapeCheck?: z.ZodType<string>
}

export interface DraftResult {
  text: string
  usage: { promptTokens: number; completionTokens: number; latencyMs: number }
}

export async function callDraft(_opts: DraftCallOptions): Promise<DraftResult> {
  throw new Error('not implemented')
}
