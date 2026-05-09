// Outbound calls TO Asana. CLAUDE.md §13, §17.
//
// createAsanaTaskFromCrm creates a task in an allowed Asana project, sets
// the `crm_contact_id` custom field, and persists a local Task row that
// holds the asana gid. Idempotency: same crm task id never creates two
// Asana tasks — we look up by asanaTaskId before calling out.

import { createId } from '@paralleldrive/cuid2'

import { writeAuditLogEntry } from '@studymind/audit'
import { db } from '@studymind/db'

import { createClient, type AsanaClient } from './client.js'
import { isAllowedProject } from './config.js'
import { CRM_CONTACT_CUSTOM_FIELD } from './types.js'

export interface OutboundContext {
  actorId: string
  requestId: string
}

export interface CreateAsanaTaskFromCrmInput {
  /** CRM Contact this task pertains to. Stored on the Asana custom field. */
  contactId: string
  title: string
  description?: string
  /** Asana project gid; must be in ASANA_ALLOWED_PROJECTS. */
  projectGid: string
  /** Custom field gid for crm_contact_id in this Asana workspace. */
  crmContactFieldGid: string
  ctx: OutboundContext
  /** Test seam. */
  client?: AsanaClient
}

export interface CreateAsanaTaskFromCrmResult {
  taskId: string
  asanaTaskId: string
  /** True iff this call resulted in a fresh Asana task creation. */
  created: boolean
}

export async function createAsanaTaskFromCrm(
  input: CreateAsanaTaskFromCrmInput,
): Promise<CreateAsanaTaskFromCrmResult> {
  if (!isAllowedProject(input.projectGid)) {
    throw new Error(`Asana project ${input.projectGid} is not in the allowlist`)
  }

  // Idempotency: a crm Task that already carries an asanaTaskId for this
  // (contactId, title) tuple short-circuits to the existing record.
  const existing = await db.task.findFirst({
    where: {
      contactId: input.contactId,
      title: input.title,
      asanaTaskId: { not: null },
      deletedAt: null,
    },
    select: { id: true, asanaTaskId: true },
  })
  if (existing && existing.asanaTaskId) {
    return { taskId: existing.id, asanaTaskId: existing.asanaTaskId, created: false }
  }

  const client = input.client ?? createClient()
  const asanaTask = await client.createTask({
    projectGid: input.projectGid,
    name: input.title,
    notes: input.description,
    customFields: { [input.crmContactFieldGid]: input.contactId },
  })

  const taskRow = await db.task.create({
    data: {
      id: createId(),
      title: input.title,
      description: input.description ?? null,
      status: 'open',
      contactId: input.contactId,
      asanaTaskId: asanaTask.gid,
      lastWrittenBy: input.ctx.actorId,
      lastWrittenAt: new Date(),
    },
    select: { id: true },
  })

  await writeAuditLogEntry(db, {
    actorId: input.ctx.actorId,
    action: 'task.created',
    target: { type: 'Task', id: taskRow.id },
    requestId: input.ctx.requestId,
    after: {
      contactId: input.contactId,
      asanaTaskId: asanaTask.gid,
      projectGid: input.projectGid,
      source: 'crm',
      crmContactCustomField: CRM_CONTACT_CUSTOM_FIELD,
    },
  })

  return { taskId: taskRow.id, asanaTaskId: asanaTask.gid, created: true }
}
