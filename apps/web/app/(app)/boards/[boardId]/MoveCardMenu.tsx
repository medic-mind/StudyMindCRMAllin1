// Per-card "Move to…" popover. ADR 0018. A button opens a small panel of
// grouped stage buttons — "This board" first, then one section per other
// board so cross-pipeline targets are obvious at a glance (the native
// <select> hid them behind optgroups the user couldn't scan). Click a
// target to move; the card shifts optimistically via onLocalMove and the
// audited card.move mutation runs in the background. CLAUDE.md §20, §28.

'use client'

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'

import { trpc } from '@/lib/trpc/client'

interface StageOption {
  id: string
  name: string
}

interface CrossBoardGroup {
  boardId: string
  boardName: string
  stages: ReadonlyArray<StageOption>
}

interface Props {
  cardId: string
  currentStageId: string
  /** Same-board stages — primary options. */
  stages: ReadonlyArray<StageOption>
  /** Other boards' stages — rendered under a per-board section. */
  crossBoardStages?: ReadonlyArray<CrossBoardGroup>
  /** Optimistic local-state shift so the card jumps the instant the
   * user picks a target. */
  onLocalMove?: (cardId: string, toStageId: string) => void
}

export function MoveCardMenu({
  cardId,
  currentStageId,
  stages,
  crossBoardStages = [],
  onLocalMove,
}: Props) {
  const router = useRouter()
  const utils = trpc.useUtils()
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const panelRef = useRef<HTMLDivElement | null>(null)
  // Portal mounts to document.body so the popover escapes each card's
  // per-stacking-context (@dnd-kit applies a CSS transform on every <li>
  // which creates one). Coordinates pin to the trigger's bounding rect.
  const [mounted, setMounted] = useState(false)
  const [coords, setCoords] = useState<{ top: number; left: number } | null>(null)
  useEffect(() => {
    setMounted(true)
  }, [])

  useLayoutEffect(() => {
    if (!open || !triggerRef.current) return
    function place() {
      const rect = triggerRef.current?.getBoundingClientRect()
      if (!rect) return
      setCoords({ top: rect.bottom + 4, left: rect.left })
    }
    place()
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true) // capture scrolls in any ancestor
    return () => {
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    function onDown(e: MouseEvent) {
      const t = e.target as Node
      if (panelRef.current?.contains(t) || triggerRef.current?.contains(t)) return
      setOpen(false)
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        setOpen(false)
        triggerRef.current?.focus()
      }
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const move = trpc.card.move.useMutation({
    onSuccess: async (_data, vars) => {
      const dest =
        stages.find((s) => s.id === vars.toStageId) ??
        crossBoardStages
          .flatMap((g) => g.stages)
          .find((s) => s.id === vars.toStageId)
      toast.success(`Moved to ${dest?.name ?? 'new stage'}`)
      await Promise.all([
        utils.card.list.invalidate(),
        utils.card.get.invalidate({ id: cardId }),
        utils.card.quickActions.list.invalidate(),
      ])
      router.refresh()
    },
    onError: (e) => toast.error(e.message ?? 'Could not move card'),
  })

  const sameBoardTargets = stages.filter((s) => s.id !== currentStageId)
  const crossBoardTargets = crossBoardStages
    .map((g) => ({
      boardName: g.boardName,
      stages: g.stages.filter((s) => s.id !== currentStageId),
    }))
    .filter((g) => g.stages.length > 0)
  if (sameBoardTargets.length === 0 && crossBoardTargets.length === 0) return null

  function pick(toStageId: string) {
    setOpen(false)
    if (onLocalMove) onLocalMove(cardId, toStageId)
    move.mutate({ cardId, toStageId })
  }

  return (
    <div className="relative">
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={move.isPending}
        onClick={(e) => {
          e.stopPropagation()
          setOpen((v) => !v)
        }}
        className="inline-flex w-full items-center justify-between gap-1 rounded border border-neutral-300 bg-white px-2 py-1 text-[11px] font-medium text-neutral-700 hover:bg-neutral-50 disabled:opacity-60"
      >
        <span>{move.isPending ? 'Moving…' : 'Move to…'}</span>
        <svg
          width="10"
          height="10"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>
      {open && mounted && coords
        ? createPortal(
            <div
              ref={panelRef}
              role="menu"
              aria-label="Move card to"
              onClick={(e) => e.stopPropagation()}
              // z-[9999] beats anything in the page; the sticky toolbar
              // sits at z-30, the column DnD overlay can climb above 50,
              // so we go well past both. Inline z-index too so a missed
              // Tailwind JIT pass can't strip the class.
              style={{
                position: 'fixed',
                top: coords.top,
                left: coords.left,
                zIndex: 9999,
              }}
              className="z-[9999] max-h-72 w-60 max-w-[calc(100vw-2rem)] overflow-y-auto rounded-lg border border-neutral-200 bg-white py-1 shadow-xl"
            >
              {sameBoardTargets.length > 0 && (
                <>
                  <p className="px-3 py-1 text-[10px] font-semibold uppercase tracking-wide text-neutral-400">
                    This board
                  </p>
                  {sameBoardTargets.map((s) => (
                    <button
                      key={s.id}
                      type="button"
                      role="menuitem"
                      onClick={() => pick(s.id)}
                      className="block w-full px-3 py-1.5 text-left text-sm text-neutral-800 hover:bg-primary-50 hover:text-primary-800"
                    >
                      {s.name}
                    </button>
                  ))}
                </>
              )}
              {crossBoardTargets.map((g) => (
                <div key={g.boardName}>
                  <p className="mt-1 border-t border-neutral-100 px-3 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wide text-neutral-400">
                    {g.boardName}
                  </p>
                  {g.stages.map((s) => (
                    <button
                      key={s.id}
                      type="button"
                      role="menuitem"
                      onClick={() => pick(s.id)}
                      className="block w-full px-3 py-1.5 text-left text-sm text-neutral-800 hover:bg-primary-50 hover:text-primary-800"
                    >
                      → {s.name}
                    </button>
                  ))}
                </div>
              ))}
              {crossBoardTargets.length === 0 && crossBoardStages.length === 0 && (
                <p className="border-t border-neutral-100 px-3 pt-2 text-[10px] text-neutral-400">
                  Create another board to enable cross-pipeline moves.
                </p>
              )}
            </div>,
            document.body,
          )
        : null}
    </div>
  )
}
