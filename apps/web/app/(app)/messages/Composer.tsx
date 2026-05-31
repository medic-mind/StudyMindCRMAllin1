// Message composer (ADR 0022). A textarea with:
//   - inline "@" autocomplete for teammate mentions
//   - a "reference a customer" picker (Contact / Family / Card / Task)
//   - Enter to send, Shift+Enter for a newline
//
// The textarea holds human-readable text ("@Alex Doe", "#Smith Family"); we
// track each inserted token's marker + id and convert to storage tokens on send
// via composeBody().

'use client'

import { useEffect, useRef, useState } from 'react'

import { AtSignIcon, LinkIcon, SendIcon } from '@/components/ui/icon'
import { Avatar } from '@/components/ui/avatar'
import { trpc } from '@/lib/trpc/client'

import {
  activeMentionQuery,
  composeBody,
  type DraftMention,
  type DraftRef,
} from './compose'
import type { RefSearchHit, UserHit } from './types'

interface Props {
  placeholder: string
  disabled?: boolean
  sending?: boolean
  autoFocus?: boolean
  onSend: (body: string) => void
}

const REF_TONE: Record<string, string> = {
  contact: 'text-primary-700',
  family: 'text-violet-700',
  card: 'text-emerald-700',
  task: 'text-amber-800',
}

export function Composer({ placeholder, disabled, sending, autoFocus, onSend }: Props) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  const [text, setText] = useState('')
  const [mentions, setMentions] = useState<DraftMention[]>([])
  const [refs, setRefs] = useState<DraftRef[]>([])

  // Mention autocomplete state.
  const [mentionQuery, setMentionQuery] = useState<{ query: string; start: number } | null>(null)
  // Reference picker state.
  const [refPickerOpen, setRefPickerOpen] = useState(false)
  const [refQuery, setRefQuery] = useState('')

  const userSearch = trpc.chat.userSearch.useQuery(
    { q: mentionQuery?.query ?? '' },
    { enabled: mentionQuery != null, staleTime: 10_000 },
  )
  const refSearch = trpc.chat.refSearch.useQuery(
    { q: refQuery },
    { enabled: refPickerOpen && refQuery.trim().length >= 2, staleTime: 10_000 },
  )

  // Grow the textarea with content, up to a cap.
  useEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 180)}px`
  }, [text])

  function onChange(value: string) {
    setText(value)
    const caret = textareaRef.current?.selectionStart ?? value.length
    setMentionQuery(activeMentionQuery(value, caret))
  }

  function insertMention(user: UserHit) {
    if (!mentionQuery) return
    const marker = `@${user.name}`
    const before = text.slice(0, mentionQuery.start)
    const afterStart = mentionQuery.start + 1 + mentionQuery.query.length
    const after = text.slice(afterStart)
    const next = `${before}${marker} ${after}`
    setText(next)
    setMentions((m) => [...m, { marker, userId: user.id }])
    setMentionQuery(null)
    requestAnimationFrame(() => {
      const el = textareaRef.current
      if (!el) return
      const pos = before.length + marker.length + 1
      el.focus()
      el.setSelectionRange(pos, pos)
    })
  }

  function insertRef(hit: RefSearchHit) {
    const marker = `#${hit.label}`
    const needsSpace = text.length > 0 && !text.endsWith(' ') && !text.endsWith('\n')
    const next = `${text}${needsSpace ? ' ' : ''}${marker} `
    setText(next)
    setRefs((r) => [...r, { marker, type: hit.type, id: hit.id }])
    setRefPickerOpen(false)
    setRefQuery('')
    requestAnimationFrame(() => textareaRef.current?.focus())
  }

  function submit() {
    const body = composeBody(text, mentions, refs)
    if (body.length === 0 || sending) return
    onSend(body)
    setText('')
    setMentions([])
    setRefs([])
    setMentionQuery(null)
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    // When the mention list is open, Enter/Tab picks the first result.
    if (mentionQuery && (userSearch.data?.length ?? 0) > 0) {
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault()
        insertMention(userSearch.data![0]!)
        return
      }
      if (e.key === 'Escape') {
        setMentionQuery(null)
        return
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      submit()
    }
  }

  return (
    <div className="relative">
      {/* Mention autocomplete */}
      {mentionQuery && (userSearch.data?.length ?? 0) > 0 ? (
        <div className="absolute bottom-full left-0 z-30 mb-2 w-72 overflow-hidden rounded-lg border border-neutral-200 bg-white shadow-lg">
          <p className="border-b border-neutral-100 px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wide text-neutral-400">
            Mention a teammate
          </p>
          <ul className="max-h-56 overflow-y-auto py-1">
            {userSearch.data!.map((u) => (
              <li key={u.id}>
                <button
                  type="button"
                  onClick={() => insertMention(u)}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-neutral-50"
                >
                  <Avatar name={u.name} size={22} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm text-neutral-900">{u.name}</span>
                    <span className="block truncate text-xs text-neutral-500">{u.email}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {/* Reference picker */}
      {refPickerOpen ? (
        <div className="absolute bottom-full left-0 z-30 mb-2 w-80 overflow-hidden rounded-lg border border-neutral-200 bg-white shadow-lg">
          <div className="border-b border-neutral-100 p-2">
            <input
              autoFocus
              value={refQuery}
              onChange={(e) => setRefQuery(e.target.value)}
              placeholder="Search contacts, families, cards, tasks…"
              className="w-full rounded-md border border-neutral-300 px-2.5 py-1.5 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500"
              onKeyDown={(e) => {
                if (e.key === 'Escape') setRefPickerOpen(false)
              }}
            />
          </div>
          <ul className="max-h-64 overflow-y-auto py-1">
            {refQuery.trim().length < 2 ? (
              <li className="px-3 py-3 text-xs text-neutral-500">Type at least 2 characters…</li>
            ) : refSearch.isLoading ? (
              <li className="px-3 py-3 text-xs text-neutral-500">Searching…</li>
            ) : (refSearch.data?.results.length ?? 0) === 0 ? (
              <li className="px-3 py-3 text-xs text-neutral-500">No matches.</li>
            ) : (
              refSearch.data!.results.map((hit) => (
                <li key={`${hit.type}:${hit.id}`}>
                  <button
                    type="button"
                    onClick={() => insertRef(hit)}
                    className="flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left hover:bg-neutral-50"
                  >
                    <span className="min-w-0">
                      <span className="block truncate text-sm text-neutral-900">{hit.label}</span>
                      {hit.sublabel ? (
                        <span className="block truncate text-xs text-neutral-500">
                          {hit.sublabel}
                        </span>
                      ) : null}
                    </span>
                    <span
                      className={`shrink-0 text-[10px] font-semibold uppercase ${REF_TONE[hit.type] ?? 'text-neutral-500'}`}
                    >
                      {hit.type}
                    </span>
                  </button>
                </li>
              ))
            )}
          </ul>
        </div>
      ) : null}

      <div className="flex items-end gap-2 rounded-xl border border-neutral-300 bg-white p-2 shadow-sm focus-within:border-primary-400 focus-within:ring-2 focus-within:ring-primary-100">
        <div className="flex shrink-0 items-center gap-0.5 pb-1">
          <button
            type="button"
            title="Mention a teammate"
            aria-label="Mention a teammate"
            disabled={disabled}
            onClick={() => {
              const next = text.length === 0 || text.endsWith(' ') ? `${text}@` : `${text} @`
              setText(next)
              requestAnimationFrame(() => {
                const el = textareaRef.current
                if (!el) return
                el.focus()
                el.setSelectionRange(next.length, next.length)
                setMentionQuery(activeMentionQuery(next, next.length))
              })
            }}
            className="inline-flex h-7 w-7 items-center justify-center rounded-md text-neutral-500 hover:bg-neutral-100 hover:text-neutral-800"
          >
            <AtSignIcon size={16} />
          </button>
          <button
            type="button"
            title="Reference a customer"
            aria-label="Reference a customer"
            disabled={disabled}
            onClick={() => setRefPickerOpen((v) => !v)}
            className="inline-flex h-7 w-7 items-center justify-center rounded-md text-neutral-500 hover:bg-neutral-100 hover:text-neutral-800"
          >
            <LinkIcon size={16} />
          </button>
        </div>

        <textarea
          ref={textareaRef}
          rows={1}
          value={text}
          disabled={disabled}
          autoFocus={autoFocus}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={onKeyDown}
          className="max-h-44 min-h-[2rem] flex-1 resize-none bg-transparent py-1 text-sm text-neutral-900 placeholder:text-neutral-400 focus-visible:outline-none"
        />

        <button
          type="button"
          aria-label="Send message"
          disabled={disabled || sending || composeBody(text, mentions, refs).length === 0}
          onClick={submit}
          className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary-600 text-white shadow-sm transition hover:bg-primary-700 disabled:cursor-not-allowed disabled:opacity-40"
        >
          <SendIcon size={16} />
        </button>
      </div>
      <p className="mt-1 px-1 text-[11px] text-neutral-400">
        <kbd className="font-sans">Enter</kbd> to send ·{' '}
        <kbd className="font-sans">Shift+Enter</kbd> for a new line · type{' '}
        <span className="font-medium text-neutral-500">@</span> to mention
      </p>
    </div>
  )
}
