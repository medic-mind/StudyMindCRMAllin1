'use client'

import { useState } from 'react'
import Link from 'next/link'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardBody } from '@/components/ui/card'
import { trpc } from '@/lib/trpc/client'

import { NewClassForm } from '../NewClassForm'
import type { ClassRow } from '../types'

function fmtMinute(m: number): string {
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
}

export function ClassesManager({
  initialClasses,
  canManage,
}: {
  initialClasses: ClassRow[]
  canManage: boolean
}) {
  const list = trpc.webinar.class.list.useQuery({}, { initialData: initialClasses })
  const [showForm, setShowForm] = useState(false)
  const classes = list.data ?? []

  return (
    <div className="space-y-5">
      {canManage ? (
        <div className="flex items-center gap-3">
          <Button onClick={() => setShowForm((s) => !s)}>{showForm ? 'Cancel' : 'New class'}</Button>
          <Link href="/webinars/cohorts" className="text-sm text-primary-700 hover:underline">
            Manage by cohort →
          </Link>
        </div>
      ) : null}

      {showForm ? <NewClassForm onCreated={() => setShowForm(false)} /> : null}

      {classes.length === 0 ? (
        <Card>
          <CardBody>
            <p className="text-sm text-neutral-500">No classes yet.</p>
          </CardBody>
        </Card>
      ) : (
        <div className="grid gap-3">
          {classes.map((c) => (
            <Link key={c.id} href={`/webinars/classes/${c.id}`} className="block">
              <Card className="transition-shadow hover:shadow-md">
                <CardBody>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="font-semibold text-neutral-900">
                          {c.subjectLabel} {c.levelLabel}
                        </span>
                        {!c.active ? <Badge tone="neutral">inactive</Badge> : null}
                        {c.zoomRotationDue ? <Badge tone="danger">rotate Zoom link</Badge> : null}
                        {!c.zoomLink ? <Badge tone="warn">no Zoom link</Badge> : null}
                        {c.hasUploadedPdf ? <Badge tone="info">PDF syllabus</Badge> : null}
                      </div>
                      <div className="mt-0.5 text-xs text-neutral-500">
                        {c.cohortName} · {c.dayLabel}s at {fmtMinute(c.startMinute)} ·{' '}
                        {c.enrollmentCount} enrolled ·{' '}
                        {c.weekState === 'in_week'
                          ? `Week ${c.currentWeekNumber} of ${c.totalWeeks}`
                          : c.weekState === 'not_started'
                            ? 'not started'
                            : c.weekState === 'between'
                              ? `on a break (next Week ${c.currentWeekNumber})`
                              : 'term ended'}
                      </div>
                    </div>
                    <span className="text-sm text-primary-700">Manage →</span>
                  </div>
                </CardBody>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  )
}
