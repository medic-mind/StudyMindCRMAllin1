'use client'

// Lightweight, dependency-free emoji picker (no new npm dep — CLAUDE.md §3).
// A curated set covering the day-to-day support vocabulary; opens as a small
// popover and calls onPick with the chosen glyph. Closes on outside click /
// Escape. Good enough for the comms-centre composer (Trengo parity) without
// pulling in a multi-hundred-KB emoji library.

import { useEffect, useRef, useState } from 'react'

const EMOJI: ReadonlyArray<{ group: string; items: string[] }> = [
  {
    group: 'Smileys',
    items: ['😀', '😊', '😅', '🙂', '😉', '😍', '🤗', '🤔', '😌', '😎', '🙏', '👍', '👏', '🙌', '🤝', '👋'],
  },
  {
    group: 'Tone',
    items: ['❤️', '🎉', '✨', '🔥', '⭐', '💯', '✅', '☑️', '❗', '❓', '⚠️', '👀', '💬', '📌', '📎', '🗓️'],
  },
  {
    group: 'Study',
    items: ['📚', '🎓', '✏️', '📝', '📖', '🧠', '🔬', '⚕️', '⚖️', '💡', '📈', '🏆', '⏰', '📞', '📧', '💷'],
  },
]

export function EmojiPicker({ onPick }: { onPick: (emoji: string) => void }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-label="Insert emoji"
        aria-expanded={open}
        className="rounded border border-neutral-300 bg-white px-2 py-1 text-sm text-neutral-600 hover:bg-neutral-50"
      >
        😊
      </button>
      {open ? (
        <div className="absolute bottom-full left-0 z-50 mb-1 w-64 rounded-lg border border-neutral-200 bg-white p-2 shadow-lg">
          {EMOJI.map((g) => (
            <div key={g.group} className="mb-1.5 last:mb-0">
              <div className="px-1 pb-0.5 text-[10px] font-semibold uppercase tracking-wide text-neutral-400">
                {g.group}
              </div>
              <div className="grid grid-cols-8 gap-0.5">
                {g.items.map((e) => (
                  <button
                    key={e}
                    type="button"
                    onClick={() => {
                      onPick(e)
                      setOpen(false)
                    }}
                    className="rounded p-1 text-lg leading-none hover:bg-neutral-100"
                  >
                    {e}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  )
}
