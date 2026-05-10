// Asana Inngest functions. CLAUDE.md §13, §17.
//
// asanaEventReceived: a task added/changed in an allowed project triggers a
// refetch (webhook is a notification, not authoritative — §7.2). If the task
// carries the `crm_contact_id` custom field, we upsert a local Task linked to
// that Contact. If absent, we ignore — we never auto-create CRM tasks for
// unknown Asana tasks.

import { createId } from '@paralleldrive/cuid2'

import { writeAuditLogEntry } from '@studymind/audit'
import { db } from '@studymind/db'
import { inngest } from '@studymind/jobs'

import { createClient } from './client'
import { isAllowedProject } from './config'
import { CRM_CONTACT_CUSTOM_FIELD, type AsanaTaskResource } from './types'

interface EventReceivedData {
  eventId: string
  providerEventRowId: string
  type: string
  projectGid: string
}

export const asanaEventReceived = inngest.createFunction(
  {
    id: 'asana/event.received',
    name: 'Process an Asana task event from ProviderEvent',
    concurrency: { limit: 10 },
    retries: 6,
  },
  { event: 'asana/event.received' },
  async ({ event, step, logger }) => {
    const data = event.data as EventReceivedData
    const { eventId, providerEventRowId, projectGid, type } = data

    if (!isAllowedProject(projectGid)) {
      logger.info({ eventId, projectGid }, 'asana event not from allowed project — skip')
      return { skipped: true, reason: 'project_not_allowed' }
    }

    const providerEvent = await step.run('load-event', async () => {
      const row = await db.providerEvent.findUniqueOrThrow({
        where: { id: providerEventRowId },
        select: { raw: true },
      })
      return row
    })
    const ev = providerEvent.raw as unknown as { resource: { gid: string }; action: string }

    // "removed" / "deleted" semantics: mark our local Task deleted but keep
    // the row for audit history. Refetch is not possible after deletion.
    if (ev.action === 'removed' || ev.action === 'deleted') {
      await step.run('soft-delete', async () => softDeleteAsanaTask(ev.resource.gid))
      await step.run('mark-processed', async () =>
        markProcessed(providerEventRowId),
      )
      return { ok: true, action: 'soft_delete' }
    }

    // Refetch the task — webhook payload is a notification only (§7.2).
    const task = await step.run('refetch-task', async () => {
      const client = createClient()
      return client.getTask(ev.resource.gid)
    })

    const contactId = readCrmContactId(task)
    if (!contactId) {
      logger.info(
        { eventId, asanaTaskId: task.gid },
        'asana task has no crm_contact_id — ignored',
      )
      await step.run('mark-processed', async () => markProcessed(providerEventRowId))
      return { ok: true, ignored: 'no_crm_contact_id' }
    }

    // Upsert local Task. Last-writer-wins per field with attribution.
    const upserted = await step.run('upsert-task', async () =>
      upsertLocalTaskFromAsana({ task, contactId }),
    )

    await step.run('audit', async () => {
      await writeAuditLogEntry(db, {
        actorId: null,
        action: ev.action === 'added' ? 'task.created' : 'task.updated',
        target: { type: 'Task', id: upserted.id },
        requestId: eventId,
        after: {
          asanaTaskId: task.gid,
          contactId,
          completed: task.completed,
          source: 'asana',
          eventType: type,
        },
      })
    })

    await step.run('mark-processed', async () => markProcessed(providerEventRowId))

    return { ok: true, taskId: upserted.id, asanaTaskId: task.gid }
  },
)

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function readCrmContactId(task: AsanaTaskResource): string | null {
  const cf = task.custom_fields ?? []
  const field = cf.find((f) => f.name === CRM_CONTACT_CUSTOM_FIELD)
  const value = field?.text_value ?? null
  if (!value || typeof value !== 'string') return null
  return value.trim() || null
}

interface UpsertInput {
  task: AsanaTaskResource
  contactId: string
}

async function upsertLocalTaskFromAsana(input: UpsertInput): Promise<{ id: string }> {
  const existing = await db.task.findUnique({
    where: { asanaTaskId: input.task.gid },
    select: { id: true },
  })
  const status = input.task.completed ? 'done' : 'open'
  const lastWrittenAt = new Date(input.task.modified_at)

  if (existing) {
    await db.task.update({
      where: { id: existing.id },
      data: {
        title: input.task.name,
        description: input.task.notes ?? null,
        status,
        contactId: input.contactId,
        lastWrittenBy: 'asana',
        lastWrittenAt,
      },
    })
    return { id: existing.id }
  }
  const created = await db.task.create({
    data: {
      id: createId(),
      title: input.task.name,
      description: input.task.notes ?? null,
      status,
      contactId: input.contactId,
      asanaTaskId: input.task.gid,
      lastWrittenBy: 'asana',
      lastWrittenAt,
    },
    select: { id: true },
  })
  return created
}

async function softDeleteAsanaTask(asanaTaskId: string): Promise<void> {
  const row = await db.task.findUnique({
    where: { asanaTaskId },
    select: { id: true },
  })
  if (!row) return
  await db.task.update({
    where: { id: row.id },
    data: { deletedAt: new Date(), lastWrittenBy: 'asana', lastWrittenAt: new Date() },
  })
}

async function markProcessed(providerEventRowId: string): Promise<void> {
  await db.providerEvent.update({
    where: { id: providerEventRowId },
    data: { processedAt: new Date() },
  })
}

export const FUNCTIONS = [asanaEventReceived] as const
