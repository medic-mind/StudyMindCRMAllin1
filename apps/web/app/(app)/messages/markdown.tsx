// Client-side markdown renderer for chat message bodies (ADR 0022 — richer
// messages). Slack-flavoured: it renders block structure (code fences,
// blockquotes, bullet / numbered lists) and inline marks (**bold**, *italic* /
// _italic_, ~~strike~~, `code`, and bare URLs) on top of the mention / ref
// token grammar from `@studymind/core/chat/parse`.
//
// Mentions (<@id>) and entity refs (<~type:id>) are atomic and never span a
// line, so we tokenise per line and apply inline markdown only to the plain
// text runs between tokens — chips are never reformatted.

'use client'

import Link from 'next/link'
import { Fragment, type ReactNode } from 'react'

import { tokenizeChatBody } from '@studymind/core/chat/parse'

import type { MessageRef } from './types'

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

export interface RenderContext {
  userNames: Record<string, string>
  refMap: Map<string, MessageRef>
  viewerId: string
}

// --- Inline marks -------------------------------------------------------------

// Ordered: code first (so * inside `code` is literal), then links, then the
// emphasis marks. Each alternative captures its inner content.
const INLINE_RE =
  /(`[^`\n]+`)|(\bhttps?:\/\/[^\s<]+)|(\*\*[^*\n]+\*\*)|(~~[^~\n]+~~)|(\*[^*\n]+\*)|(_[^_\n]+_)/g

function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const out: ReactNode[] = []
  let last = 0
  let m: RegExpExecArray | null
  INLINE_RE.lastIndex = 0
  let i = 0
  while ((m = INLINE_RE.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index))
    const raw = m[0]
    const key = `${keyPrefix}-i${i++}`
    if (m[1]) {
      out.push(
        <code
          key={key}
          className="rounded bg-neutral-100 px-1 py-0.5 font-mono text-[0.8em] text-neutral-800"
        >
          {raw.slice(1, -1)}
        </code>,
      )
    } else if (m[2]) {
      out.push(
        <a
          key={key}
          href={raw}
          target="_blank"
          rel="noopener noreferrer"
          className="text-primary-700 underline decoration-primary-300 underline-offset-2 hover:text-primary-800"
        >
          {raw}
        </a>,
      )
    } else if (m[3]) {
      out.push(
        <strong key={key} className="font-semibold text-neutral-900">
          {raw.slice(2, -2)}
        </strong>,
      )
    } else if (m[4]) {
      out.push(
        <span key={key} className="line-through opacity-80">
          {raw.slice(2, -2)}
        </span>,
      )
    } else if (m[5]) {
      out.push(
        <em key={key} className="italic">
          {raw.slice(1, -1)}
        </em>,
      )
    } else if (m[6]) {
      out.push(
        <em key={key} className="italic">
          {raw.slice(1, -1)}
        </em>,
      )
    }
    last = m.index + raw.length
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}

// --- Mention / ref chips + inline markdown for a single line ------------------

function renderLine(line: string, ctx: RenderContext, keyPrefix: string): ReactNode[] {
  const tokens = tokenizeChatBody(line)
  return tokens.map((token, idx) => {
    const key = `${keyPrefix}-t${idx}`
    if (token.kind === 'text') {
      return <Fragment key={key}>{renderInline(token.text, key)}</Fragment>
    }
    if (token.kind === 'mention') {
      const isMe = token.userId === ctx.viewerId
      const name = ctx.userNames[token.userId] ?? 'someone'
      return (
        <span
          key={key}
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
    const ref = ctx.refMap.get(`${token.refType}:${token.refId}`)
    const label = ref?.label ?? token.refType
    const tone = REF_TONE[token.refType] ?? REF_TONE['contact']
    const sigil = REF_SIGIL[token.refType] ?? '#'
    const chip = (
      <span
        className={`inline-flex max-w-[18rem] items-center gap-1 truncate rounded px-1.5 py-0.5 align-baseline text-[0.8rem] font-medium ring-1 ${tone}`}
      >
        <span aria-hidden className="opacity-60">
          {sigil}
        </span>
        <span className="truncate">{label}</span>
      </span>
    )
    return ref?.href ? (
      <Link key={key} href={ref.href} className="align-baseline">
        {chip}
      </Link>
    ) : (
      <Fragment key={key}>{chip}</Fragment>
    )
  })
}

// --- Block structure ----------------------------------------------------------

type Block =
  | { kind: 'code'; lines: string[] }
  | { kind: 'quote'; lines: string[] }
  | { kind: 'ul'; items: string[] }
  | { kind: 'ol'; items: string[] }
  | { kind: 'p'; lines: string[] }

function groupBlocks(body: string): Block[] {
  const lines = body.split('\n')
  const blocks: Block[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]!
    // Fenced code block.
    if (line.trimStart().startsWith('```')) {
      const code: string[] = []
      i++
      while (i < lines.length && !lines[i]!.trimStart().startsWith('```')) {
        code.push(lines[i]!)
        i++
      }
      i++ // skip closing fence
      blocks.push({ kind: 'code', lines: code })
      continue
    }
    // Blockquote run.
    if (line.startsWith('> ') || line === '>') {
      const quote: string[] = []
      while (i < lines.length && (lines[i]!.startsWith('> ') || lines[i] === '>')) {
        quote.push(lines[i]!.replace(/^>\s?/, ''))
        i++
      }
      blocks.push({ kind: 'quote', lines: quote })
      continue
    }
    // Bullet list run.
    if (/^\s*[-*]\s+/.test(line)) {
      const items: string[] = []
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i]!)) {
        items.push(lines[i]!.replace(/^\s*[-*]\s+/, ''))
        i++
      }
      blocks.push({ kind: 'ul', items })
      continue
    }
    // Numbered list run.
    if (/^\s*\d+\.\s+/.test(line)) {
      const items: string[] = []
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i]!)) {
        items.push(lines[i]!.replace(/^\s*\d+\.\s+/, ''))
        i++
      }
      blocks.push({ kind: 'ol', items })
      continue
    }
    // Paragraph run (consume until a blank line or a block starter).
    const para: string[] = []
    while (
      i < lines.length &&
      lines[i]!.trim() !== '' &&
      !lines[i]!.trimStart().startsWith('```') &&
      !lines[i]!.startsWith('>') &&
      !/^\s*[-*]\s+/.test(lines[i]!) &&
      !/^\s*\d+\.\s+/.test(lines[i]!)
    ) {
      para.push(lines[i]!)
      i++
    }
    if (para.length > 0) {
      blocks.push({ kind: 'p', lines: para })
    } else {
      i++ // blank line — skip
    }
  }
  return blocks
}

/** Render a stored chat body into block + inline markdown with mention/ref chips. */
export function renderMessageBody(body: string, ctx: RenderContext): ReactNode {
  const blocks = groupBlocks(body)
  return blocks.map((block, bi) => {
    const key = `b${bi}`
    switch (block.kind) {
      case 'code':
        return (
          <pre
            key={key}
            className="my-1 overflow-x-auto rounded-md border border-neutral-200 bg-neutral-50 p-2 font-mono text-[0.8em] leading-relaxed text-neutral-800"
          >
            <code>{block.lines.join('\n')}</code>
          </pre>
        )
      case 'quote':
        return (
          <blockquote
            key={key}
            className="my-1 border-l-2 border-neutral-300 pl-3 text-neutral-600"
          >
            {block.lines.map((l, li) => (
              <div key={li}>{renderLine(l, ctx, `${key}-${li}`)}</div>
            ))}
          </blockquote>
        )
      case 'ul':
        return (
          <ul key={key} className="my-1 list-disc space-y-0.5 pl-5">
            {block.items.map((it, li) => (
              <li key={li}>{renderLine(it, ctx, `${key}-${li}`)}</li>
            ))}
          </ul>
        )
      case 'ol':
        return (
          <ol key={key} className="my-1 list-decimal space-y-0.5 pl-5">
            {block.items.map((it, li) => (
              <li key={li}>{renderLine(it, ctx, `${key}-${li}`)}</li>
            ))}
          </ol>
        )
      case 'p':
      default:
        return (
          <p key={key} className="whitespace-pre-wrap break-words">
            {block.lines.map((l, li) => (
              <Fragment key={li}>
                {li > 0 ? <br /> : null}
                {renderLine(l, ctx, `${key}-${li}`)}
              </Fragment>
            ))}
          </p>
        )
    }
  })
}
