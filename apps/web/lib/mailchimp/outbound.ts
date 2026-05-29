// Push a contact to a Mailchimp audience as a subscriber (idempotent upsert
// keyed by the MD5 of the lowercase email). CLAUDE.md §16 — Mailchimp is a
// partner integration, kept narrow and explicit.
//
// We deliberately don't pull in @mailchimp/mailchimp_marketing — a single
// `fetch` keeps the surface tiny and avoids a new dependency.

import { createHash } from 'node:crypto'

export class MailchimpNotConfiguredError extends Error {
  override readonly name = 'MailchimpNotConfiguredError'
}

export class MailchimpError extends Error {
  override readonly name = 'MailchimpError'
  constructor(
    message: string,
    public readonly status: number,
    public readonly detail?: string,
  ) {
    super(message)
  }
}

export interface PushContactArgs {
  email: string
  firstName?: string | null
  lastName?: string | null
  tags?: readonly string[]
  /** Override the configured list id. */
  listId?: string
}

export interface PushContactResult {
  subscriberHash: string
  status: 'subscribed' | 'pending' | 'unsubscribed' | 'transactional' | 'cleaned' | 'archived'
  webUrl?: string
}

function subscriberHash(email: string): string {
  return createHash('md5').update(email.trim().toLowerCase()).digest('hex')
}

function datacenterFromKey(apiKey: string): string | null {
  const idx = apiKey.lastIndexOf('-')
  if (idx < 0) return null
  const dc = apiKey.slice(idx + 1).trim()
  return /^[a-z]{2,5}\d+$/i.test(dc) ? dc : null
}

export async function pushContactToMailchimp(args: PushContactArgs): Promise<PushContactResult> {
  const apiKey = process.env['MAILCHIMP_API_KEY']?.trim()
  const listId = (args.listId ?? process.env['MAILCHIMP_DEFAULT_LIST_ID'])?.trim()
  if (!apiKey || !listId) {
    throw new MailchimpNotConfiguredError(
      'Mailchimp is not configured. Set MAILCHIMP_API_KEY and MAILCHIMP_DEFAULT_LIST_ID.',
    )
  }
  const dc = datacenterFromKey(apiKey)
  if (!dc) {
    throw new MailchimpNotConfiguredError(
      'MAILCHIMP_API_KEY is not in the expected `xxx-usN` shape.',
    )
  }
  if (!args.email.trim()) {
    throw new MailchimpError('Contact has no email to push.', 400)
  }

  const hash = subscriberHash(args.email)
  const url = `https://${dc}.api.mailchimp.com/3.0/lists/${encodeURIComponent(listId)}/members/${hash}`
  const body = {
    email_address: args.email.trim(),
    status_if_new: 'subscribed' as const,
    merge_fields: {
      FNAME: args.firstName ?? '',
      LNAME: args.lastName ?? '',
    },
    ...(args.tags && args.tags.length > 0 ? { tags: [...args.tags] } : {}),
  }

  const res = await fetch(url, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Basic ${Buffer.from(`anystring:${apiKey}`).toString('base64')}`,
    },
    body: JSON.stringify(body),
  })

  const text = await res.text()
  if (!res.ok) {
    let detail: string | undefined
    try {
      const parsed = JSON.parse(text) as { detail?: string }
      detail = parsed.detail
    } catch {
      detail = text.slice(0, 200)
    }
    throw new MailchimpError(`Mailchimp upsert failed (HTTP ${res.status})`, res.status, detail)
  }
  const parsed = JSON.parse(text) as {
    id?: string
    status?: PushContactResult['status']
    web_id?: number
  }
  return {
    subscriberHash: hash,
    status: parsed.status ?? 'subscribed',
    ...(parsed.web_id
      ? { webUrl: `https://${dc}.admin.mailchimp.com/lists/members/view?id=${parsed.web_id}` }
      : {}),
  }
}
