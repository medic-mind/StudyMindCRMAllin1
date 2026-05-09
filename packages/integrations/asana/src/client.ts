// Asana REST client. CLAUDE.md §13.
// PAT-authenticated. Scoped to allowed projects only — caller is expected to
// pass project gids that match `isAllowedProject`.

import { safeFetch } from '@studymind/core/observability/safe-fetch'

import type { AsanaTaskResource } from './types.js'

export const ASANA_API_BASE = 'https://app.asana.com/api/1.0' as const

export class AsanaApiError extends Error {
  override readonly name = 'AsanaApiError'
  constructor(
    public readonly status: number,
    public readonly path: string,
    public readonly body: unknown,
  ) {
    super(`Asana ${status} on ${path}`)
  }
}

export interface AsanaCreateTaskInput {
  projectGid: string
  name: string
  notes?: string
  /** Map of custom_field gid -> string value (e.g. crm_contact_id). */
  customFields?: Record<string, string>
}

export interface AsanaUpdateTaskInput {
  taskGid: string
  name?: string
  notes?: string
  completed?: boolean
  customFields?: Record<string, string>
}

export interface AsanaClient {
  readonly baseUrl: string
  getTask(taskGid: string): Promise<AsanaTaskResource>
  createTask(input: AsanaCreateTaskInput): Promise<AsanaTaskResource>
  updateTask(input: AsanaUpdateTaskInput): Promise<AsanaTaskResource>
  listProjects(): Promise<Array<{ gid: string; name: string }>>
}

export interface CreateAsanaClientOptions {
  pat?: string
  baseUrl?: string
  fetchImpl?: typeof fetch
}

export function createClient(opts: CreateAsanaClientOptions = {}): AsanaClient {
  const pat = opts.pat ?? process.env['ASANA_PAT']
  if (!pat) throw new Error('ASANA_PAT is not set')

  const baseUrl = opts.baseUrl ?? ASANA_API_BASE
  const fetchImpl = opts.fetchImpl ?? safeFetch

  async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${pat}`,
      Accept: 'application/json',
    }
    if (body !== undefined) headers['Content-Type'] = 'application/json'

    const res = await fetchImpl(`${baseUrl}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
    const text = await res.text()
    const parsed = text ? (JSON.parse(text) as unknown) : null
    if (!res.ok) {
      throw new AsanaApiError(res.status, path, parsed)
    }
    return parsed as T
  }

  return {
    baseUrl,
    async getTask(taskGid) {
      const res = await request<{ data: AsanaTaskResource }>('GET', `/tasks/${taskGid}`)
      return res.data
    },
    async createTask(input) {
      const customFields = input.customFields ?? {}
      const res = await request<{ data: AsanaTaskResource }>('POST', `/tasks`, {
        data: {
          projects: [input.projectGid],
          name: input.name,
          notes: input.notes ?? '',
          custom_fields: customFields,
        },
      })
      return res.data
    },
    async updateTask(input) {
      const data: Record<string, unknown> = {}
      if (input.name !== undefined) data['name'] = input.name
      if (input.notes !== undefined) data['notes'] = input.notes
      if (input.completed !== undefined) data['completed'] = input.completed
      if (input.customFields) data['custom_fields'] = input.customFields
      const res = await request<{ data: AsanaTaskResource }>(
        'PUT',
        `/tasks/${input.taskGid}`,
        { data },
      )
      return res.data
    },
    async listProjects() {
      const res = await request<{ data: Array<{ gid: string; name: string }> }>(
        'GET',
        `/projects`,
      )
      return res.data
    },
  }
}
