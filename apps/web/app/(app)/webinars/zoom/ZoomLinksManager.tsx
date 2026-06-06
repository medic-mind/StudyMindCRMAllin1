'use client'

import { useState } from 'react'
import { toast } from 'sonner'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardBody } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { trpc } from '@/lib/trpc/client'

import type { ClassRow } from '../types'

export function ZoomLinksManager({
  initial,
  canManage,
}: {
  initial: ClassRow[]
  canManage: boolean
}) {
  const utils = trpc.useUtils()
  const list = trpc.webinar.class.list.useQuery({}, { initialData: initial })
  const classes = list.data ?? []
  const dueCount = classes.filter((c) => c.zoomRotationDue).length

  return (
    <div className="space-y-4">
      <Card className={dueCount > 0 ? 'border-amber-200 bg-amber-50/50' : undefined}>
        <CardBody>
          <p className="text-sm text-neutral-700">
            Put each class&apos;s Zoom link here. Every reminder email uses the current link, and the
            CRM opens a staff task to rotate any link older than its interval (default 4 weeks) — so a
            lapsed or unsubscribed member can&apos;t keep joining on an old link.
          </p>
          {dueCount > 0 ? (
            <p className="mt-2 text-sm font-medium text-amber-800">
              {dueCount} link{dueCount === 1 ? '' : 's'} due for rotation.
            </p>
          ) : null}
        </CardBody>
      </Card>

      {classes.length === 0 ? (
        <Card>
          <CardBody>
            <p className="text-sm text-neutral-500">No classes yet.</p>
          </CardBody>
        </Card>
      ) : (
        <div className="space-y-2">
          {classes.map((c) => (
            <ZoomRow key={c.id} row={c} canManage={canManage} onSaved={() => void utils.webinar.class.list.invalidate()} />
          ))}
        </div>
      )}
    </div>
  )
}

function ZoomRow({
  row,
  canManage,
  onSaved,
}: {
  row: ClassRow
  canManage: boolean
  onSaved: () => void
}) {
  const [link, setLink] = useState(row.zoomLink ?? '')
  const save = trpc.webinar.class.setZoomLink.useMutation({
    onSuccess: () => {
      toast.success('Zoom link updated — rotation reminder cleared')
      onSaved()
    },
    onError: (e) => toast.error(e.message),
  })
  const updated = row.zoomLinkUpdatedAt ? new Date(row.zoomLinkUpdatedAt) : null
  return (
    <Card>
      <CardBody>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <span className="font-medium text-neutral-900">
              {row.subjectLabel} {row.levelLabel}
            </span>
            <span className="text-xs text-neutral-500">{row.cohortName}</span>
            {row.zoomRotationDue ? <Badge tone="danger">rotate now</Badge> : null}
            {!row.zoomLink ? <Badge tone="warn">not set</Badge> : null}
          </div>
          <span className="text-xs text-neutral-400">
            {updated ? `updated ${updated.toLocaleDateString('en-GB')}` : 'never set'}
          </span>
        </div>
        {canManage ? (
          <form
            className="mt-2 flex gap-2"
            onSubmit={(e) => {
              e.preventDefault()
              save.mutate({ id: row.id, zoomLink: link })
            }}
          >
            <Input
              type="url"
              placeholder="https://zoom.us/j/…"
              value={link}
              onChange={(e) => setLink(e.target.value)}
              required
            />
            <Button type="submit" disabled={save.isPending}>
              {save.isPending ? 'Saving…' : 'Save'}
            </Button>
          </form>
        ) : (
          <p className="mt-2 break-all text-sm text-neutral-700">{row.zoomLink ?? '— not set —'}</p>
        )}
      </CardBody>
    </Card>
  )
}
