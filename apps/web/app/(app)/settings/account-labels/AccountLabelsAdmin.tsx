// Account-labels management (Manager+). Create / edit / archive the shared
// label catalogue applied to B2B accounts. Mirrors the quick-replies admin
// shape (CLAUDE.md §30 — consistency over novelty).

'use client'

import { useState } from 'react'
import { toast } from 'sonner'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { trpc } from '@/lib/trpc/client'

// A small, accessible swatch palette. Hex values (the column stores #RRGGBB,
// same convention as Company / BusinessAccount.color).
const SWATCHES = [
  '#475569', // slate
  '#2563eb', // blue
  '#7c3aed', // violet
  '#db2777', // pink
  '#dc2626', // red
  '#ea580c', // orange
  '#ca8a04', // amber
  '#16a34a', // green
  '#0d9488', // teal
  '#0891b2', // cyan
] as const

interface Editing {
  id: string | null
  name: string
  color: string
  description: string
}

const EMPTY: Editing = { id: null, name: '', color: SWATCHES[0], description: '' }

export function AccountLabelsAdmin() {
  const utils = trpc.useUtils()
  const list = trpc.accountLabel.list.useQuery({ includeArchived: true })
  const [editing, setEditing] = useState<Editing | null>(null)

  const invalidate = () => {
    void utils.accountLabel.list.invalidate()
    void utils.accountLabel.pickList.invalidate()
  }

  const create = trpc.accountLabel.create.useMutation({
    onSuccess: () => {
      toast.success('Label created')
      setEditing(null)
      invalidate()
    },
    onError: (e) => toast.error(e.message),
  })
  const update = trpc.accountLabel.update.useMutation({
    onSuccess: () => {
      toast.success('Saved')
      setEditing(null)
      invalidate()
    },
    onError: (e) => toast.error(e.message),
  })
  const archive = trpc.accountLabel.archive.useMutation({
    onSuccess: () => invalidate(),
    onError: (e) => toast.error(e.message),
  })

  const items = list.data ?? []
  const activeCount = items.filter((i) => !i.archived).length

  const submit = () => {
    if (!editing) return
    if (!editing.name.trim()) {
      toast.error('Name is required')
      return
    }
    const payload = {
      name: editing.name.trim(),
      color: editing.color,
      description: editing.description.trim() || null,
    }
    if (editing.id) update.mutate({ id: editing.id, ...payload })
    else create.mutate(payload)
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-neutral-600">
          {activeCount} active label{activeCount === 1 ? '' : 's'}
        </p>
        {!editing ? (
          <Button type="button" onClick={() => setEditing({ ...EMPTY })}>
            New label
          </Button>
        ) : null}
      </div>

      {editing ? (
        <Card className="space-y-3 p-4">
          <div className="grid gap-3 sm:grid-cols-[1fr_1fr]">
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-xs text-neutral-600">Name</span>
              <Input
                value={editing.name}
                onChange={(e) => setEditing({ ...editing, name: e.target.value })}
                placeholder="e.g. Priority, MAT, Funded"
                maxLength={60}
              />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-xs text-neutral-600">Description (optional)</span>
              <Input
                value={editing.description}
                onChange={(e) => setEditing({ ...editing, description: e.target.value })}
                placeholder="What this label means"
                maxLength={280}
              />
            </label>
          </div>
          <div className="flex flex-col gap-1.5 text-sm">
            <span className="text-xs text-neutral-600">Colour</span>
            <div className="flex flex-wrap items-center gap-2">
              {SWATCHES.map((hex) => {
                const on = editing.color.toLowerCase() === hex.toLowerCase()
                return (
                  <button
                    key={hex}
                    type="button"
                    aria-label={`Colour ${hex}`}
                    aria-pressed={on}
                    onClick={() => setEditing({ ...editing, color: hex })}
                    className={
                      on
                        ? 'h-7 w-7 rounded-full ring-2 ring-neutral-900 ring-offset-2'
                        : 'h-7 w-7 rounded-full ring-1 ring-inset ring-black/10 hover:scale-110 transition-transform'
                    }
                    style={{ backgroundColor: hex }}
                  />
                )
              })}
            </div>
          </div>
          <div className="flex gap-2">
            <Button type="button" onClick={submit} disabled={create.isPending || update.isPending}>
              {editing.id ? 'Save' : 'Create'}
            </Button>
            <button
              type="button"
              onClick={() => setEditing(null)}
              className="text-sm text-neutral-500 hover:underline"
            >
              Cancel
            </button>
          </div>
        </Card>
      ) : null}

      <Card className="overflow-hidden">
        {items.length === 0 ? (
          <p className="p-6 text-sm text-neutral-600">
            No labels yet. Create one — it becomes available to apply (in bulk) from the Accounts
            list.
          </p>
        ) : (
          <ul className="divide-y divide-neutral-100">
            {items.map((l) => (
              <li key={l.id} className={l.archived ? 'p-3 opacity-60' : 'p-3'}>
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span
                        aria-hidden
                        className="h-3 w-3 flex-none rounded-full"
                        style={{ backgroundColor: l.color ?? '#94a3b8' }}
                      />
                      <span className="font-medium text-neutral-900">{l.name}</span>
                      <Badge tone="neutral">
                        {l.usageCount} account{l.usageCount === 1 ? '' : 's'}
                      </Badge>
                      {l.archived ? <Badge tone="warn">Archived</Badge> : null}
                    </div>
                    {l.description ? (
                      <p className="mt-1 line-clamp-2 text-sm text-neutral-600">{l.description}</p>
                    ) : null}
                  </div>
                  <div className="flex shrink-0 gap-2 text-sm">
                    {!l.archived ? (
                      <button
                        type="button"
                        onClick={() =>
                          setEditing({
                            id: l.id,
                            name: l.name,
                            color: l.color ?? SWATCHES[0],
                            description: l.description ?? '',
                          })
                        }
                        className="text-primary-700 hover:underline"
                      >
                        Edit
                      </button>
                    ) : null}
                    <button
                      type="button"
                      onClick={() => archive.mutate({ id: l.id, restore: l.archived })}
                      className="text-neutral-500 hover:underline"
                    >
                      {l.archived ? 'Restore' : 'Archive'}
                    </button>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  )
}
