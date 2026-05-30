// Reaction pills + the add-reaction popover for a message (ADR 0022).

'use client'

import { useEffect, useRef, useState } from 'react'

import { CHAT_REACTION_EMOJI } from '@studymind/core/chat'

import { SmilePlusIcon } from '@/components/ui/icon'

import type { MessageReaction } from './types'

interface Props {
  reactions: ReadonlyArray<MessageReaction>
  onToggle: (emoji: string) => void
  compact?: boolean
}

export function Reactions({ reactions, onToggle, compact = false }: Props) {
  const [pickerOpen, setPickerOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!pickerOpen) return
    function onDown(e: MouseEvent) {
      if (!wrapRef.current?.contains(e.target as Node)) setPickerOpen(false)
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setPickerOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [pickerOpen])

  return (
    <div className="relative flex flex-wrap items-center gap-1" ref={wrapRef}>
      {reactions.map((r) => (
        <button
          key={r.emoji}
          type="button"
          title={r.names.join(', ')}
          onClick={() => onToggle(r.emoji)}
          className={
            r.mine
              ? 'inline-flex items-center gap-1 rounded-full border border-primary-300 bg-primary-50 px-1.5 py-0.5 text-xs text-primary-800'
              : 'inline-flex items-center gap-1 rounded-full border border-neutral-200 bg-white px-1.5 py-0.5 text-xs text-neutral-700 hover:border-neutral-300'
          }
        >
          <span aria-hidden>{r.emoji}</span>
          <span className="tabular-nums">{r.count}</span>
        </button>
      ))}

      <button
        type="button"
        aria-label="Add reaction"
        onClick={() => setPickerOpen((v) => !v)}
        className={
          compact && reactions.length === 0
            ? 'inline-flex h-6 w-6 items-center justify-center rounded-full text-neutral-400 opacity-0 transition group-hover:opacity-100 hover:bg-neutral-100 hover:text-neutral-700'
            : 'inline-flex h-6 w-6 items-center justify-center rounded-full text-neutral-400 hover:bg-neutral-100 hover:text-neutral-700'
        }
      >
        <SmilePlusIcon size={15} />
      </button>

      {pickerOpen ? (
        <div className="absolute bottom-7 left-0 z-20 flex gap-0.5 rounded-lg border border-neutral-200 bg-white p-1 shadow-lg">
          {CHAT_REACTION_EMOJI.map((emoji) => (
            <button
              key={emoji}
              type="button"
              onClick={() => {
                onToggle(emoji)
                setPickerOpen(false)
              }}
              className="rounded-md px-1.5 py-1 text-base hover:bg-neutral-100"
            >
              {emoji}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  )
}
