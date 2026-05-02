// Structured-output OpenAI client wrapper. See CLAUDE.md Section 18.1.
// Used for classification / extraction tasks via response_format=json_schema.

import { z } from 'zod'

export interface StructuredCallOptions<T> {
  task: string
  promptVersion: string
  model: 'gpt-4o' | 'gpt-4o-mini'
  schema: z.ZodType<T>
  system: string
  user: string
  temperature?: number
}

export interface StructuredResult<T> {
  data: T
  usage: { promptTokens: number; completionTokens: number; latencyMs: number }
}

export async function callStructured<T>(
  _opts: StructuredCallOptions<T>,
): Promise<StructuredResult<T>> {
  throw new Error('not implemented')
}
