// Task detail page (slice B). Shows title, description, assignee, due, status
// controls (sales_executive+), the linked contact, and the shared comment
// thread wired to task.comments.*. CLAUDE.md §26, §20.

import { notFound } from 'next/navigation'

import { PageBody } from '@/components/shell/page-body'
import { PageHeader } from '@/components/shell/page-header'
import { getCurrentUser } from '@/lib/auth/server'
import { createServerCaller } from '@/lib/trpc/server'

import { TaskDetail } from './TaskDetail'

export const dynamic = 'force-dynamic'

const CAN_WRITE = new Set(['ceo', 'senior_manager', 'manager', 'sales_executive'])

interface PageProps {
  params: Promise<{ taskId: string }>
}

export default async function TaskDetailPage({ params }: PageProps) {
  const { taskId } = await params
  const me = await getCurrentUser()
  const role = me?.role ?? 'virtual_assistant'
  const canWrite = CAN_WRITE.has(role)
  const canComment = Boolean(me)
  const currentUserName = me?.name?.trim() || me?.email || 'You'

  const caller = await createServerCaller()

  let task
  try {
    task = await caller.task.get({ id: taskId })
  } catch {
    notFound()
  }

  const [comments, assignableUsers] = await Promise.all([
    caller.task.comments.list({ taskId }),
    canWrite ? caller.task.assignableUsers({}) : Promise.resolve([]),
  ])

  return (
    <>
      <PageHeader title={task.title} breadcrumbs={[{ label: 'Tasks', href: '/tasks' }]} />
      <PageBody>
        <TaskDetail
          task={task}
          comments={comments}
          assignableUsers={assignableUsers}
          canWrite={canWrite}
          canComment={canComment}
          currentUserName={currentUserName}
        />
      </PageBody>
    </>
  )
}
