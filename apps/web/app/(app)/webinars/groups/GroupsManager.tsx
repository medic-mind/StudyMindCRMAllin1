'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardBody } from '@/components/ui/card'
import { trpc } from '@/lib/trpc/client'

import { NewClassForm } from '../NewClassForm'
import { TimetableImport } from '../cohorts/TimetableImport'
import type { ClassRow } from '../types'

const WEEK_TONE: Record<string, 'success' | 'info' | 'neutral'> = {
  in_week: 'success',
  not_started: 'info',
  between: 'neutral',
  ended: 'neutral',
}

function timeLabel(startMinute: number): string {
  const h = Math.floor(startMinute / 60)
  const m = startMinute % 60
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}

export function GroupsManager({
  initialGroups,
  canManage,
}: {
  initialGroups: ClassRow[]
  canManage: boolean
}) {
  const router = useRouter()
  const utils = trpc.useUtils()
  const list = trpc.webinar.class.list.useQuery(undefined, { initialData: initialGroups })
  const del = trpc.webinar.class.delete.useMutation({
    onSuccess: () => {
      toast.success('Group deleted')
      void utils.webinar.class.list.invalidate()
    },
    onError: (e) => toast.error(e.message),
  })

  const [showNew, setShowNew] = useState(false)
  const groups = list.data ?? []

  return (
    <div className="space-y-6">
      {canManage ? <TimetableImport /> : null}

      {canManage ? (
        <Card>
          <CardBody>
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-sm font-semibold text-neutral-900">New group</h2>
                <p className="mt-0.5 text-xs text-neutral-500">
                  A group is one subject + level (e.g. A-Level Biology). It has its own weekly
                  classes, Zoom link, template, settings and students.
                </p>
              </div>
              <Button size="sm" variant={showNew ? 'ghost' : 'secondary'} onClick={() => setShowNew((s) => !s)}>
                {showNew ? 'Close' : '＋ New group'}
              </Button>
            </div>
            {showNew ? (
              <div className="mt-3">
                <NewClassForm onCreated={(id) => router.push(`/webinars/groups/${id}`)} />
              </div>
            ) : null}
          </CardBody>
        </Card>
      ) : null}

      {groups.length === 0 ? (
        <Card>
          <CardBody>
            <p className="text-sm text-neutral-500">
              No groups yet. Import a timetable above, or add one with <strong>New group</strong>.
            </p>
          </CardBody>
        </Card>
      ) : (
        <div className="grid gap-3">
          {groups.map((g) => (
            <Card key={g.id} className="transition-shadow hover:shadow-md">
              <CardBody>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <Link href={`/webinars/groups/${g.id}`} className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-base font-semibold text-neutral-900">
                        {g.subjectLabel} {g.levelLabel}
                      </span>
                      <Badge tone="neutral">{g.cohortName}</Badge>
                      {!g.active ? <Badge tone="neutral">paused</Badge> : null}
                      {g.weekState ? (
                        <Badge tone={WEEK_TONE[g.weekState] ?? 'neutral'}>
                          {g.weekState === 'in_week' && g.currentWeekNumber
                            ? `Week ${g.currentWeekNumber} of ${g.totalWeeks}`
                            : g.weekState === 'not_started'
                              ? 'Not started'
                              : g.weekState === 'ended'
                                ? 'Ended'
                                : 'Between weeks'}
                        </Badge>
                      ) : null}
                    </div>
                    <div className="mt-1 text-xs text-neutral-500">
                      {g.dayLabel}s at {timeLabel(g.startMinute)} · {g.enrollmentCount} student
                      {g.enrollmentCount === 1 ? '' : 's'} ·{' '}
                      {g.zoomLink ? (
                        <span className="text-emerald-700">Zoom set</span>
                      ) : (
                        <span className="text-amber-700">Zoom link needed</span>
                      )}
                      {g.zoomRotationDue ? <span className="text-red-700"> · rotate Zoom</span> : null}
                    </div>
                  </Link>
                  <div className="flex items-center gap-2">
                    <Link href={`/webinars/groups/${g.id}`} className="text-sm text-primary-700">
                      Open →
                    </Link>
                    {canManage ? (
                      <Button
                        variant="ghost"
                        size="xs"
                        onClick={() => {
                          if (
                            confirm(
                              `Delete "${g.subjectLabel} ${g.levelLabel}"? This removes its schedule, students and Zoom meeting. This cannot be undone.`,
                            )
                          ) {
                            del.mutate({ id: g.id })
                          }
                        }}
                      >
                        Delete
                      </Button>
                    ) : null}
                  </div>
                </div>
              </CardBody>
            </Card>
          ))}
        </div>
      )}
    </div>
  )
}
