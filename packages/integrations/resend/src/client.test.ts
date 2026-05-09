import { describe, expect, it } from 'vitest'

import { sendEmail } from './client'

describe('resend.sendEmail', () => {
  it('skips when no API key is configured', async () => {
    const r = await sendEmail({ to: 'x@y.com', subject: 's', body: 'b' })
    expect(r.status).toBe('skipped')
  })

  it('posts to api.resend.com with bearer auth and plaintext body', async () => {
    let captured: { url?: string; init?: RequestInit } = {}
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      captured = { url: typeof url === 'string' ? url : url.toString(), init }
      return new Response(JSON.stringify({ id: 'r-1' }), { status: 200 })
    }) as unknown as typeof fetch
    const r = await sendEmail({
      to: ['dpo@studymind.co.uk'],
      subject: 'test',
      body: 'hello',
      apiKey: 'rs_xxx',
      fetchImpl,
    })
    expect(r.status).toBe('sent')
    expect(r.id).toBe('r-1')
    expect(captured.url).toBe('https://api.resend.com/emails')
    expect(
      (captured.init?.headers as Record<string, string>).authorization,
    ).toBe('Bearer rs_xxx')
    const body = JSON.parse((captured.init?.body as string) ?? '{}')
    expect(body.subject).toBe('test')
    expect(body.text).toBe('hello')
    expect(body.to).toEqual(['dpo@studymind.co.uk'])
  })
})
