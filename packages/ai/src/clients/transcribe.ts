// Whisper transcription client. CLAUDE.md §10, §18.
//
// The Aircall fallback flow uses this when AI Assist is not on the line:
// download the recording, hand the bytes to Whisper, then run a structured
// outcome classifier on the resulting transcript.

import { BusinessError, logger } from '@studymind/core'

import { checkBudget, recordUsage } from '../budget.js'
import { getOpenAI } from './openai.js'

export interface TranscribeAudioInput {
  /**
   * Audio bytes. We accept a Buffer (Node) or a Uint8Array; the OpenAI SDK
   * will convert under the hood. Caller is responsible for download.
   */
  audio: Buffer | Uint8Array
  /** Filename hint so OpenAI infers the format (e.g. `recording.mp3`). */
  filename: string
  /** Optional ISO-639-1 hint. */
  language?: string
  /** Free-form context for log correlation (call id, family id). */
  ctx?: Record<string, unknown>
}

export interface TranscribeAudioResult {
  text: string
  language?: string
  durationSec?: number
}

const MODEL = 'whisper-1'

export async function transcribeAudio(input: TranscribeAudioInput): Promise<TranscribeAudioResult> {
  const budget = checkBudget('transcription')
  if (!budget.allowed) {
    throw new BusinessError(
      'AI_BUDGET_EXCEEDED',
      'Daily AI budget exhausted for task transcription.',
      { task: 'transcription', mode: budget.mode },
    )
  }
  if (budget.mode === 'page') {
    logger.warn(
      { task: 'transcription', remainingUsd: budget.remainingUsd, ...input.ctx },
      'ai.budget.threshold_breached',
    )
  }

  const startedAt = Date.now()
  const client = getOpenAI()

  // The OpenAI SDK expects a File-like object. Node 20 has File globally.
  const blob: File = new File([input.audio as BlobPart], input.filename, {
    type: filenameToMime(input.filename),
  })

  const result = await client.audio.transcriptions.create({
    model: MODEL,
    file: blob,
    ...(input.language ? { language: input.language } : {}),
    response_format: 'verbose_json',
  })

  const latencyMs = Date.now() - startedAt
  // Whisper is priced per minute; the token table treats it as zero-cost. We
  // still record usage so the dashboard sees the call.
  recordUsage({ task: 'transcription', costUsd: 0 })

  const text = (result as unknown as { text?: string }).text ?? ''
  if (!text) {
    throw new BusinessError(
      'AI_OUTPUT_INVALID',
      'Whisper returned no transcript text.',
      { filename: input.filename },
    )
  }

  const language = (result as unknown as { language?: string }).language
  const durationSec = (result as unknown as { duration?: number }).duration

  logger.info(
    {
      task: 'transcription',
      model: MODEL,
      latencyMs,
      bytes: input.audio.byteLength,
      durationSec,
      ...input.ctx,
    },
    'ai.transcribe.completed',
  )

  return {
    text,
    ...(language ? { language } : {}),
    ...(typeof durationSec === 'number' ? { durationSec } : {}),
  }
}

function filenameToMime(filename: string): string {
  const lower = filename.toLowerCase()
  if (lower.endsWith('.mp3')) return 'audio/mpeg'
  if (lower.endsWith('.wav')) return 'audio/wav'
  if (lower.endsWith('.m4a')) return 'audio/mp4'
  if (lower.endsWith('.ogg')) return 'audio/ogg'
  if (lower.endsWith('.webm')) return 'audio/webm'
  return 'application/octet-stream'
}
