// Inline "+ Label" control ON the board card face, so an agent tags a card
// without opening the detail modal (ops request, 2026-07). Clicking it expands
// a compact panel — right inside the card — to toggle the board's labels or
// create a new one. It reuses the same tRPC surface as the modal editor
// (`card.setLabels`, `label.list`, `label.create`), so behaviour is identical.
//
// It lives inside BoardCard's click-through body (`pointer-events-none`), so
// every interactive element re-enables pointer events and stops propagation —
// otherwise a click would open the card modal or start a drag.

'use client'

import { useRouter } from 'next/navigation'
import { useState, type SyntheticEvent } from 'react'
import { toast } from 'sonner'

import { TagIcon } from '@/components/ui/icon'
import { trpc } from '@/lib/trpc/client'

import { resolveStageColor } from '../../pipeline/stage-color'

// Same hex palette as the modal editor so a tag looks identical wherever made.
const PALETTE = [
  '#2563eb',
  '#dc2626',
  '#16a34a',
  '#f59e0b',
  '#7c3aed',
  '#db2777',
  '#0891b2',
  '#4b5563',
]

interface Props {
  cardId: string
  /** Ids of the labels currently on the card (drives the ✓ state). */
  currentLabelIds: ReadonlyArray<string>
}

export function CardLabelQuickAdd({ cardId, currentLabelIds }: Props) {
  const utils = trpc.useUtils()
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [newName, setNewName] = useState('')
  const [newColor, setNewColor] = useState<string>(PALETTE[0]!)

  const availableQuery = trpc.label.list.useQuery(undefined, { enabled: open })

  const refresh = async () => {
    await Promise.all([utils.card.get.invalidate({ id: cardId }), utils.card.list.invalidate()])
    router.refresh()
  }
  const setLabels = trpc.card.setLabels.useMutation({
    onSuccess: refresh,
    onError: (e) => toast.error(e.message ?? 'Could not update labels'),
  })
  const createLabel = trpc.label.create.useMutation()

  const has = (id: string) => currentLabelIds.includes(id)
  function toggle(id: string) {
    const next = has(id) ? currentLabelIds.filter((x) => x !== id) : [...currentLabelIds, id]
    setLabels.mutate({ cardId, labelIds: [...next] })
  }

  async function createAndApply() {
    const name = newName.trim()
    if (!name) return
    const existing = (availableQuery.data ?? []).find(
      (l) => l.name.toLowerCase() === name.toLowerCase(),
    )
    let id = existing?.id
    if (!id) {
      try {
        const created = await createLabel.mutateAsync({ name, color: newColor })
        id = created.id
        await utils.label.list.invalidate()
      } catch (e) {
        toast.error(e instanceof Error ? e.message : 'Could not create the tag')
        return
      }
    }
    if (id && !has(id)) setLabels.mutate({ cardId, labelIds: [...currentLabelIds, id] })
    setNewName('')
  }

  const busy = setLabels.isPending || createLabel.isPending
  // Interactions must not open the card modal or start a drag.
  const stop = (e: SyntheticEvent) => e.stopPropagation()

  return (
    <>
      <button
        type="button"
        onPointerDown={stop}
        onKeyDown={stop}
        onClick={(e) => {
          stop(e)
          setOpen((v) => !v)
        }}
        aria-label="Add label"
        aria-expanded={open}
        className="pointer-events-auto inline-flex items-center gap-1 rounded-full border border-dashed border-neutral-300 px-2 py-0.5 text-[10px] font-medium text-neutral-500 transition-colors hover:border-primary-300 hover:text-primary-700"
      >
        <TagIcon size={10} />
        Label
      </button>

      {open ? (
        // basis-full breaks this panel onto its own row inside the flex-wrap
        // chip row, and it expands the card inline (no clipping by the column's
        // scroll — the reason a floating popover would be fragile here).
        <div
          onPointerDown={stop}
          onClick={stop}
          // Stop key events reaching the card's drag sensor (see CardModal) so
          // Space in the "New tag" field types a space instead of picking up
          // the card.
          onKeyDown={stop}
          onKeyUp={stop}
          className="pointer-events-auto mt-1.5 basis-full rounded-md border border-neutral-200 bg-white p-2 shadow-sm"
        >
          {(availableQuery.data ?? []).length > 0 ? (
            <div className="flex flex-wrap gap-1">
              {(availableQuery.data ?? []).map((l) => (
                <button
                  key={l.id}
                  type="button"
                  onClick={(e) => {
                    stop(e)
                    toggle(l.id)
                  }}
                  disabled={busy}
                  className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium text-white transition-opacity disabled:opacity-50"
                  style={{ backgroundColor: resolveStageColor(l.color), opacity: has(l.id) ? 1 : 0.5 }}
                  title={has(l.id) ? `Remove ${l.name}` : `Add ${l.name}`}
                >
                  {has(l.id) ? '✓ ' : ''}
                  {l.name}
                </button>
              ))}
            </div>
          ) : availableQuery.isLoading ? (
            <p className="text-[11px] text-neutral-400">Loading tags…</p>
          ) : (
            <p className="text-[11px] text-neutral-500">No tags yet — create one below.</p>
          )}

          <div className="mt-2 flex items-center gap-1.5 border-t border-neutral-100 pt-2">
            <input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  void createAndApply()
                }
              }}
              maxLength={32}
              placeholder="New tag…"
              aria-label="New tag name"
              className="min-w-0 flex-1 rounded border border-neutral-300 bg-white px-2 py-1 text-xs"
            />
            <button
              type="button"
              onClick={(e) => {
                stop(e)
                void createAndApply()
              }}
              disabled={busy || !newName.trim()}
              className="shrink-0 rounded bg-primary-600 px-2 py-1 text-xs font-medium text-white hover:bg-primary-700 disabled:opacity-50"
            >
              Add
            </button>
          </div>
          <div className="mt-1.5 flex items-center gap-1">
            {PALETTE.map((c) => (
              <button
                key={c}
                type="button"
                onClick={(e) => {
                  stop(e)
                  setNewColor(c)
                }}
                aria-label={`Colour ${c}`}
                aria-pressed={newColor === c}
                className={`h-4 w-4 rounded-full ${
                  newColor === c ? 'ring-2 ring-neutral-800 ring-offset-1' : 'ring-1 ring-neutral-200'
                }`}
                style={{ backgroundColor: c }}
              />
            ))}
          </div>
        </div>
      ) : null}
    </>
  )
}
