'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { trpc } from '@/lib/trpc/client'

const COLOR_PRESETS = [
  '#9333ea', // primary purple
  '#2563eb', // blue
  '#0284c7', // sky
  '#059669', // emerald
  '#d97706', // amber
  '#e11d48', // rose
  '#dc2626', // red
  '#0891b2', // cyan
  '#7c3aed', // violet
  '#475569', // slate
]

function slugify(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

interface CompanyRow {
  id: string
  name: string
  slug: string
  color: string | null
  description: string | null
  archived: boolean
  contactCount: number
  familyCount: number
}

function CompanyEditor({
  row,
  onClose,
}: {
  row: CompanyRow
  onClose: () => void
}) {
  const router = useRouter()
  const [name, setName] = useState(row.name)
  const [slug, setSlug] = useState(row.slug)
  const [color, setColor] = useState<string>(row.color ?? COLOR_PRESETS[0]!)
  const [description, setDescription] = useState(row.description ?? '')

  const update = trpc.company.update.useMutation()
  const archive = trpc.company.archive.useMutation()
  const restore = trpc.company.restore.useMutation()
  const utils = trpc.useUtils()

  async function refresh() {
    await Promise.all([
      utils.company.list.invalidate(),
      utils.company.pickList.invalidate(),
    ])
    router.refresh()
  }

  async function save() {
    try {
      await update.mutateAsync({
        id: row.id,
        name: name.trim(),
        slug: slug.trim() || slugify(name),
        color,
        description: description.trim() || null,
      })
      toast.success('Company updated')
      await refresh()
      onClose()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not save')
    }
  }

  async function toggleArchive() {
    try {
      if (row.archived) {
        await restore.mutateAsync({ id: row.id })
        toast.success('Company restored')
      } else {
        await archive.mutateAsync({ id: row.id })
        toast.success('Company archived')
      }
      await refresh()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not change')
    }
  }

  return (
    <div className="space-y-3 border-t border-neutral-200 bg-neutral-50/40 px-4 py-4">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor={`name-${row.id}`}>Name</Label>
          <Input
            id={`name-${row.id}`}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`slug-${row.id}`}>Slug</Label>
          <Input
            id={`slug-${row.id}`}
            value={slug}
            onChange={(e) => setSlug(e.target.value)}
            placeholder={slugify(name)}
          />
        </div>
      </div>
      <div className="space-y-1.5">
        <Label>Colour</Label>
        <div className="flex flex-wrap gap-1.5">
          {COLOR_PRESETS.map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => setColor(c)}
              aria-label={`Pick ${c}`}
              className={`h-7 w-7 rounded-full border-2 transition-transform ${
                color === c ? 'scale-110 border-neutral-900' : 'border-white shadow'
              }`}
              style={{ backgroundColor: c }}
            />
          ))}
        </div>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor={`description-${row.id}`}>Description</Label>
        <Input
          id={`description-${row.id}`}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" size="sm" onClick={save} disabled={update.isPending}>
          {update.isPending ? 'Saving…' : 'Save'}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={toggleArchive}>
          {row.archived ? 'Restore' : 'Archive'}
        </Button>
      </div>
    </div>
  )
}

export function CompaniesAdmin() {
  const router = useRouter()
  const companies = trpc.company.list.useQuery({ includeArchived: true })
  const create = trpc.company.create.useMutation()
  const utils = trpc.useUtils()

  const [name, setName] = useState('')
  const [slug, setSlug] = useState('')
  const [color, setColor] = useState<string>(COLOR_PRESETS[0]!)
  const [description, setDescription] = useState('')
  const [expanded, setExpanded] = useState<string | null>(null)

  async function refresh() {
    await Promise.all([
      utils.company.list.invalidate(),
      utils.company.pickList.invalidate(),
    ])
    router.refresh()
  }

  async function onCreate(e: React.FormEvent) {
    e.preventDefault()
    if (!name.trim()) return
    try {
      const result = await create.mutateAsync({
        name: name.trim(),
        slug: slug.trim() || undefined,
        color,
        description: description.trim() || undefined,
      })
      toast.success('Company added')
      setName('')
      setSlug('')
      setDescription('')
      setExpanded(result.id)
      await refresh()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not add')
    }
  }

  const rows = companies.data ?? []

  return (
    <div className="space-y-5">
      <form
        onSubmit={onCreate}
        className="space-y-3 rounded-xl border border-neutral-200 bg-white p-5 shadow-card"
      >
        <h2 className="text-sm font-semibold text-neutral-900">Add a company</h2>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="newCompanyName">Name</Label>
            <Input
              id="newCompanyName"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Sister brand name"
              required
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="newCompanySlug">Slug (optional)</Label>
            <Input
              id="newCompanySlug"
              value={slug}
              onChange={(e) => setSlug(e.target.value)}
              placeholder={slugify(name) || 'auto-from-name'}
            />
          </div>
        </div>
        <div className="space-y-1.5">
          <Label>Colour</Label>
          <div className="flex flex-wrap gap-1.5">
            {COLOR_PRESETS.map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => setColor(c)}
                aria-label={`Pick ${c}`}
                className={`h-7 w-7 rounded-full border-2 transition-transform ${
                  color === c ? 'scale-110 border-neutral-900' : 'border-white shadow'
                }`}
                style={{ backgroundColor: c }}
              />
            ))}
          </div>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="newCompanyDescription">Description (optional)</Label>
          <Input
            id="newCompanyDescription"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </div>
        <div>
          <Button type="submit" disabled={create.isPending || !name.trim()}>
            {create.isPending ? 'Adding…' : 'Add company'}
          </Button>
        </div>
      </form>

      <Card className="overflow-hidden">
        {rows.length === 0 ? (
          <p className="p-6 text-sm text-neutral-500">
            No companies yet. Add one above to start tagging contacts.
          </p>
        ) : (
          <ul>
            {rows.map((c) => (
              <li key={c.id} className="border-b border-neutral-100 last:border-b-0">
                <button
                  type="button"
                  onClick={() => setExpanded((cur) => (cur === c.id ? null : c.id))}
                  className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-primary-50/30"
                >
                  <span
                    aria-hidden
                    className="h-3 w-3 shrink-0 rounded-full"
                    style={{ backgroundColor: c.color ?? '#94a3b8' }}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium text-neutral-900">{c.name}</span>
                      <span className="font-mono text-[11px] text-neutral-500">
                        {c.slug}
                      </span>
                      {c.archived ? <Badge tone="neutral">Archived</Badge> : null}
                    </div>
                    {c.description ? (
                      <div className="truncate text-xs text-neutral-500">{c.description}</div>
                    ) : null}
                  </div>
                  <span className="text-xs text-neutral-500">
                    {c.contactCount} contact{c.contactCount === 1 ? '' : 's'}
                    {c.familyCount > 0
                      ? ` · ${c.familyCount} famil${c.familyCount === 1 ? 'y' : 'ies'}`
                      : ''}
                  </span>
                </button>
                {expanded === c.id ? (
                  <CompanyEditor row={c} onClose={() => setExpanded(null)} />
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  )
}
