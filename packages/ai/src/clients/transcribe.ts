// Audio transcription client. CLAUDE.md §10, §18; provider seam ADR 0028.
//
// The Aircall fallback flow uses this when AI Assist is not on the line:
// download the recording, hand the bytes to the active provider, then run a
// structured outcome classifier on the resulting transcript.
//
// Provider routing (ADR 0028):
//   - gemini  → Gemini multimodal: inline the audio bytes + a transcribe prompt.
//   - openai  → Whisper (audio.transcriptions).
// The public shape is identical regardless of provider.

import { BusinessError, logger } from '@studymind/core'

import { checkBudget, recordUsage } from '../budget'
import { getGemini } from './gemini'
import { resolveTranscriptionModel } from './models'
import { getOpenAI } from './openai'

export interface TranscribeAudioInput {
  /**
   * Audio bytes. We accept a Buffer (Node) or a Uint8Array; the provider SDK
   * converts under the hood. Caller is responsible for download.
   */
  audio: Buffer | Uint8Array
  /** Filename hint so the provider infers the format (e.g. `recording.mp3`). */
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

  const { provider, model } = resolveTranscriptionModel()
  const startedAt = Date.now()

  const result =
    provider === 'gemini'
      ? await transcribeGemini(model, input)
      : await transcribeOpenAI(model, input)

  const latencyMs = Date.now() - startedAt
  // Transcription is priced per audio minute on both providers; the token table
  // treats it as zero token-side. We still record usage so the dashboard sees it.
  recordUsage({ task: 'transcription', costUsd: 0 })

  if (!result.text) {
    throw new BusinessError('AI_OUTPUT_INVALID', 'Transcription returned no text.', {
      filename: input.filename,
      provider,
    })
  }

  logger.info(
    {
      task: 'transcription',
      provider,
      model,
      latencyMs,
      bytes: input.audio.byteLength,
      durationSec: result.durationSec,
      ...input.ctx,
    },
    'ai.transcribe.completed',
  )

  return result
}

async function transcribeOpenAI(
  model: string,
  input: TranscribeAudioInput,
): Promise<TranscribeAudioResult> {
  const client = getOpenAI()
  // The OpenAI SDK expects a File-like object. Node 20 has File globally.
  const blob: File = new File([input.audio as BlobPart], input.filename, {
    type: filenameToMime(input.filename),
  })
  const result = await client.audio.transcriptions.create({
    model,
    file: blob,
    ...(input.language ? { language: input.language } : {}),
    response_format: 'verbose_json',
  })
  const r = result as unknown as { text?: string; language?: string; duration?: number }
  return {
    text: r.text ?? '',
    ...(r.language ? { language: r.language } : {}),
    ...(typeof r.duration === 'number' ? { durationSec: r.duration } : {}),
  }
}

async function transcribeGemini(
  model: string,
  input: TranscribeAudioInput,
): Promise<TranscribeAudioResult> {
  const client = getGemini()
  const base64 = Buffer.from(input.audio).toString('base64')
  const langHint = input.language ? ` The audio language is ${input.language}.` : ''
  const response = await client.models.generateContent({
    model,
    contents: [
      {
        role: 'user',
        parts: [
          {
            text:
              'Transcribe this audio recording verbatim. Return only the spoken ' +
              `text with no commentary, labels, or timestamps.${langHint}`,
          },
          {
            inlineData: {
              mimeType: filenameToMime(input.filename),
              data: base64,
            },
          },
        ],
      },
    ],
  })
  return {
    text: (response.text ?? '').trim(),
    ...(input.language ? { language: input.language } : {}),
  }
}

function filenameToMime(filename: string): string {
  const lower = filename.toLowerCase()
  if (lower.endsWith('.mp3')) return 'audio/mpeg'
  if (lower.endsWith('.wav')) return 'audio/wav'
  if (lower.endsWith('.m4a')) return 'audio/mp4'
  if (lower.endsWith('.ogg')) return 'audio/ogg'
  if (lower.endsWith('.webm')) return 'audio/webm'
  if (lower.endsWith('.flac')) return 'audio/flac'
  if (lower.endsWith('.aac')) return 'audio/aac'
  return 'application/octet-stream'
}
