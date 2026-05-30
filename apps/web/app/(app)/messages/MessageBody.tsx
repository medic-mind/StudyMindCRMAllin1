// Renders a stored chat body into text + mention chips + entity-reference
// chips (ADR 0022). Uses the shared client-safe tokenizer so the rendered
// output always matches what the server extracted.

'use client'

import Link from 'next/link'

import { tokenizeChatBody } from '@studymind/core/chat/parse'

import type { MessageRef } from './types'

interface Props {
  body: string
  /** id → display name for mentioned users. */
  userNames: Record<string, string>
  /** Resolved entity refs for this message, keyed lookup by `${type}:${id}`. */
  refs: ReadonlyArray<MessageRef>
  /** The viewer's own id, so "@you" mentions can be highlighted. */
  viewerId: string
}

const REF_TONE: Record<string, string> = {
  contact: 'bg-primary-50 text-primary-700 ring-primary-100 hover:bg-primary-100',
  family: 'bg-violet-50 text-violet-700 ring-violet-100 hover:bg-violet-100',
  card: 'bg-emerald-50 text-emerald-700 ring-emerald-100 hover:bg-emerald-100',
  task: 'bg-amber-50 text-amber-800 ring-amber-100 hover:bg-amber-100',
}

const REF_SIGIL: Record<string, string> = {
  contact: '@',
  family: '⌂',
  card: '▤',
  task: '✓',
}

export function MessageBody({ body, userNames, refs, viewerId }: Props) {
  const tokens = tokenizeChatBody(body)
  const refMap = new Map(refs.map((r) => [`${r.type}:${r.id}`, r] as const))

  return (
    <span className="whitespace-pre-wrap break-words text-sm leading-relaxed text-neutral-800">
      {tokens.map((token, i) => {
        if (token.kind === 'text') {
          return <span key={i}>{token.text}</span>
        }
        if (token.kind === 'mention') {
          const isMe = token.userId === viewerId
          const name = userNames[token.userId] ?? 'someone'
          return (
            <span
              key={i}
              className={
                isMe
                  ? 'rounded bg-amber-100 px-1 font-medium text-amber-900'
                  : 'rounded bg-primary-50 px-1 font-medium text-primary-700'
              }
            >
              @{name}
            </span>
          )
        }
        // entity ref
        const ref = refMap.get(`${token.refType}:${token.refId}`)
        const label = ref?.label ?? token.refType
        const tone = REF_TONE[token.refType] ?? REF_TONE['contact']
        const sigil = REF_SIGIL[token.refType] ?? '#'
        const content = (
          <span
            className={`inline-flex max-w-[18rem] items-center gap-1 truncate rounded px-1.5 py-0.5 align-baseline text-[0.8rem] font-medium ring-1 ${tone}`}
          >
            <span aria-hidden className="opacity-60">
              {sigil}
            </span>
            <span className="truncate">{label}</span>
          </span>
        )
        if (ref?.href) {
          return (
            <Link key={i} href={ref.href} className="align-baseline">
              {content}
            </Link>
          )
        }
        return <span key={i}>{content}</span>
      })}
    </span>
  )
}
