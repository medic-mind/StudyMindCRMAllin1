// Preview/download a group's schedule PDF — the uploaded syllabus if one exists,
// else the generated branded term schedule. Same artefact the weekly reminder
// attaches, so staff preview exactly what families receive.

import { NextResponse } from 'next/server'

import { getCurrentUser } from '@/lib/auth/server'
import { db } from '@/lib/db'
import { buildClassSchedulePdf, loadClassSchedule } from '@/lib/webinar/schedule-helpers'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const me = await getCurrentUser()
  if (!me) return new NextResponse('Unauthorized', { status: 401 })
  const { id } = await params

  const uploaded = await db.webinarClass.findFirst({
    where: { id, deletedAt: null },
    select: { syllabusPdfData: true, syllabusPdfFileName: true },
  })
  if (!uploaded) return new NextResponse('Not found', { status: 404 })

  let body: Buffer
  let filename: string
  if (uploaded.syllabusPdfData) {
    body = Buffer.from(uploaded.syllabusPdfData)
    filename = uploaded.syllabusPdfFileName || 'syllabus.pdf'
  } else {
    const schedule = await loadClassSchedule(db, id)
    if (!schedule) return new NextResponse('Not found', { status: 404 })
    body = buildClassSchedulePdf(schedule)
    filename = 'class-schedule.pdf'
  }

  return new NextResponse(body as unknown as BodyInit, {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="${filename.replace(/[\r\n"]/g, '_')}"`,
      'Cache-Control': 'no-store',
    },
  })
}
