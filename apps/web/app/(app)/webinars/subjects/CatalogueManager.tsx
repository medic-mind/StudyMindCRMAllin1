'use client'

import { useState } from 'react'
import { toast } from 'sonner'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardBody } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { trpc } from '@/lib/trpc/client'

import type { CatalogueRow } from '../types'

/**
 * Manage one webinar catalogue (subjects OR levels/types). Both tRPC routers
 * share the same shape, so we pick the namespace by `kind`.
 */
export function CatalogueManager({
  kind,
  title,
  hint,
  initial,
  canManage,
}: {
  kind: 'subject' | 'level'
  title: string
  hint: string
  initial: CatalogueRow[]
  canManage: boolean
}) {
  const utils = trpc.useUtils()
  const api = kind === 'subject' ? trpc.webinar.subject : trpc.webinar.level
  const list = api.list.useQuery({ includeArchived: true }, { initialData: initial })
  const invalidate = () => {
    if (kind === 'subject') {
      void utils.webinar.subject.list.invalidate()
      void utils.webinar.subject.pickList.invalidate()
    } else {
      void utils.webinar.level.list.invalidate()
      void utils.webinar.level.pickList.invalidate()
    }
  }

  const create = api.create.useMutation({
    onSuccess: () => {
      toast.success(`${title} added`)
      setLabel('')
      setAliases('')
      invalidate()
    },
    onError: (e) => toast.error(e.message),
  })
  const setArchived = api.setArchived.useMutation({
    onSuccess: invalidate,
    onError: (e) => toast.error(e.message),
  })
  const update = api.update.useMutation({
    onSuccess: () => {
      toast.success('Saved')
      invalidate()
    },
    onError: (e) => toast.error(e.message),
  })

  const [label, setLabel] = useState('')
  const [aliases, setAliases] = useState('')

  const rows = list.data ?? []

  return (
    <Card>
      <CardBody>
        <h2 className="text-sm font-semibold text-neutral-900">{title}</h2>
        <p className="mt-1 text-xs text-neutral-500">{hint}</p>

        <div className="mt-3 space-y-1.5">
          {rows.map((r) => (
            <Row
              key={r.id}
              row={r}
              canManage={canManage}
              onArchive={(archived) => setArchived.mutate({ id: r.id, archived })}
              onSaveAliases={(a) => update.mutate({ id: r.id, aliases: a })}
            />
          ))}
          {rows.length === 0 ? (
            <p className="text-sm text-neutral-500">No options yet — add the first one above and it appears in the New-group dropdowns.</p>
          ) : null}
        </div>

        {canManage ? (
          <form
            className="mt-4 flex flex-wrap items-end gap-2 border-t border-neutral-100 pt-3"
            onSubmit={(e) => {
              e.preventDefault()
              const aliasList = aliases
                .split(',')
                .map((a) => a.trim())
                .filter(Boolean)
              create.mutate({ label, aliases: aliasList })
            }}
          >
            <div className="grow">
              <label className="mb-1 block text-xs font-medium text-neutral-600">
                Name (e.g. {kind === 'subject' ? 'Further Maths' : 'UCAT'})
              </label>
              <Input value={label} onChange={(e) => setLabel(e.target.value)} required />
            </div>
            <div className="grow">
              <label className="mb-1 block text-xs font-medium text-neutral-600">
                Match aliases (comma-separated, optional)
              </label>
              <Input
                value={aliases}
                onChange={(e) => setAliases(e.target.value)}
                placeholder={kind === 'subject' ? 'fm, f-maths' : 'ukcat'}
              />
            </div>
            <Button type="submit" disabled={create.isPending}>
              Add
            </Button>
          </form>
        ) : null}
      </CardBody>
    </Card>
  )
}

function Row({
  row,
  canManage,
  onArchive,
  onSaveAliases,
}: {
  row: CatalogueRow
  canManage: boolean
  onArchive: (archived: boolean) => void
  onSaveAliases: (aliases: string[]) => void
}) {
  const [editing, setEditing] = useState(false)
  const [aliases, setAliases] = useState(row.aliases.join(', '))
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 rounded bg-neutral-50 px-3 py-2 text-sm">
      <div className="min-w-0">
        <span className="font-medium text-neutral-800">{row.label}</span>{' '}
        <code className="rounded bg-neutral-100 px-1 text-[11px] text-neutral-500">{row.handle}</code>
        {row.archived ? <Badge tone="neutral" className="ml-2">archived</Badge> : null}
        {editing ? (
          <div className="mt-1 flex gap-2">
            <Input
              value={aliases}
              onChange={(e) => setAliases(e.target.value)}
              placeholder="aliases, comma-separated"
            />
            <Button
              size="xs"
              onClick={() => {
                onSaveAliases(aliases.split(',').map((a) => a.trim()).filter(Boolean))
                setEditing(false)
              }}
            >
              Save
            </Button>
          </div>
        ) : row.aliases.length > 0 ? (
          <span className="ml-2 text-xs text-neutral-400">aka {row.aliases.join(', ')}</span>
        ) : null}
      </div>
      {canManage ? (
        <div className="flex items-center gap-1">
          <Button size="xs" variant="ghost" onClick={() => setEditing((s) => !s)}>
            {editing ? 'Cancel' : 'Aliases'}
          </Button>
          <Button size="xs" variant="ghost" onClick={() => onArchive(!row.archived)}>
            {row.archived ? 'Restore' : 'Archive'}
          </Button>
        </div>
      ) : null}
    </div>
  )
}
