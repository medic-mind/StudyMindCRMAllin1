// Add / remove / create labels (tags) on a card, right from the card modal.
// Labels render on the card face too, so this is how the team tags cards with
// their own colour-coded labels. Existing labels are picked from the shared
// board catalogue; a brand-new "special label" is created inline (name + colour)
// and applied in one go. Card-write gated (Sales Executive / VA and above —
// the tRPC `card.setLabels` + `label.create` allow the same set).

'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { toast } from 'sonner'

import { trpc } from '@/lib/trpc/client'

import { resolveStageColor } from '../../pipeline/stage-color'

interface LabelChip {
  id: string
  name: string
  color: string
}

// A friendly, distinct colour palette (hex so it renders identically on the
// card face and the sidebar chip).
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

export function CardLabelsEditor({
  cardId,
  labels,
  canWrite,
}: {
  cardId: string
  labels: ReadonlyArray<LabelChip>
  canWrite: boolean
}) {
  const utils = trpc.useUtils()
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [newName, setNewName] = useState('')
  const [newColor, setNewColor] = useState<string>(PALETTE[0]!)

  const availableQuery = trpc.label.list.useQuery(undefined, { enabled: open && canWrite })

  const refresh = async () => {
    await Promise.all([utils.card.get.invalidate({ id: cardId }), utils.card.list.invalidate()])
    router.refresh()
  }
  const setLabels = trpc.card.setLabels.useMutation({
    onSuccess: refresh,
    onError: (e) => toast.error(e.message ?? 'Could not update labels'),
  })
  const createLabel = trpc.label.create.useMutation()

  const currentIds = labels.map((l) => l.id)
  const has = (id: string) => currentIds.includes(id)

  function toggle(id: string) {
    const next = has(id) ? currentIds.filter((x) => x !== id) : [...currentIds, id]
    setLabels.mutate({ cardId, labelIds: next })
  }

  async function createAndApply() {
    const name = newName.trim()
    if (!name) return
    // Reuse an existing label of the same name (label.create rejects dupes)
    // rather than erroring at the user.
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
    if (id && !has(id)) setLabels.mutate({ cardId, labelIds: [...currentIds, id] })
    setNewName('')
  }

  // Read-only (Virtual-Assistant-and-below cannot write cards): just the chips.
  if (!canWrite) {
    if (labels.length === 0) return <p className="text-sm text-neutral-400">None</p>
    return (
      <div className="flex flex-wrap gap-1">
        {labels.map((l) => (
          <span
            key={l.id}
            className="inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium text-white"
            style={{ backgroundColor: resolveStageColor(l.color) }}
          >
            {l.name}
          </span>
        ))}
      </div>
    )
  }

  const busy = setLabels.isPending || createLabel.isPending

  return (
    <div>
      <div className="flex flex-wrap items-center gap-1">
        {labels.map((l) => (
          <span
            key={l.id}
            className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium text-white"
            style={{ backgroundColor: resolveStageColor(l.color) }}
          >
            {l.name}
            <button
              type="button"
              onClick={() => toggle(l.id)}
              disabled={busy}
              aria-label={`Remove ${l.name}`}
              className="-mr-0.5 rounded-full px-0.5 leading-none text-white/80 hover:text-white disabled:opacity-50"
            >
              ×
            </button>
          </span>
        ))}
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="inline-flex items-center gap-1 rounded-full border border-dashed border-neutral-300 px-2 py-0.5 text-[10px] font-medium text-neutral-600 transition-colors hover:border-primary-300 hover:text-primary-700"
        >
          + Tag
        </button>
      </div>

      {open ? (
        <div className="mt-2 space-y-2 rounded-md border border-neutral-200 bg-neutral-50/60 p-2">
          {(availableQuery.data ?? []).length > 0 ? (
            <div className="flex flex-wrap gap-1">
              {(availableQuery.data ?? []).map((l) => (
                <button
                  key={l.id}
                  type="button"
                  onClick={() => toggle(l.id)}
                  disabled={busy}
                  className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium transition-opacity disabled:opacity-50 ${
                    has(l.id) ? 'text-white' : 'text-white/70 ring-1 ring-inset ring-white/30'
                  }`}
                  style={{ backgroundColor: resolveStageColor(l.color), opacity: has(l.id) ? 1 : 0.55 }}
                >
                  {has(l.id) ? '✓ ' : ''}
                  {l.name}
                </button>
              ))}
            </div>
          ) : (
            <p className="text-[11px] text-neutral-500">No tags yet — create one below.</p>
          )}

          <div className="border-t border-neutral-200 pt-2">
            <div className="flex items-center gap-1.5">
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
                className="min-w-0 flex-1 rounded border border-neutral-300 bg-white px-2 py-1 text-xs"
                aria-label="New tag name"
              />
              <button
                type="button"
                onClick={() => void createAndApply()}
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
                  onClick={() => setNewColor(c)}
                  aria-label={`Colour ${c}`}
                  aria-pressed={newColor === c}
                  className={`h-4 w-4 rounded-full ring-offset-1 ${
                    newColor === c ? 'ring-2 ring-neutral-800' : 'ring-1 ring-neutral-200'
                  }`}
                  style={{ backgroundColor: c }}
                />
              ))}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}
