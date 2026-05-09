// Domain-mapped types for Asana. CLAUDE.md §13.
//
// Asana sends batches of events; we normalise to a typed shape and dedupe
// each event on its (resource gid, change action, created_at) tuple.

export interface AsanaEvent {
  /** "task", "story", "project", etc. We only handle task. */
  resource: { gid: string; resource_type: string }
  /** "added" | "changed" | "removed" | "deleted" */
  action: string
  /** Project the event fired against (Asana includes this for parent gid). */
  parent?: { gid: string; resource_type: string } | null
  user?: { gid: string } | null
  created_at: string
  change?: { field: string; action: string } | null
}

export interface AsanaEventBatch {
  events: AsanaEvent[]
}

/** Stable per-event id used for ProviderEvent dedupe. */
export function asanaEventId(ev: AsanaEvent): string {
  const change = ev.change?.field ?? ev.action
  return `${ev.resource.gid}:${change}:${ev.created_at}`
}

export interface AsanaTaskResource {
  gid: string
  name: string
  notes?: string
  completed: boolean
  modified_at: string
  custom_fields?: Array<{
    gid: string
    name: string
    text_value?: string | null
  }>
  projects?: Array<{ gid: string }>
}

export const CRM_CONTACT_CUSTOM_FIELD = 'crm_contact_id' as const
