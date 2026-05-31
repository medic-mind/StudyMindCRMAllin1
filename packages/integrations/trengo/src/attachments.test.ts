// Tests for the Trengo attachment normaliser. ADR 0020 Phase 6d.
//
// The Inngest function itself is orchestration (fetch + S3 + DB) and is
// covered by integration / staging tests; the unit invariant we lock in
// here is that the normaliser only emits records the downstream worker
// can actually act on (every record has a stable id, a url, and a
// sanitised filename).

import { describe, expect, it } from 'vitest'

import { normaliseTrengoAttachment } from './types'

describe('normaliseTrengoAttachment', () => {
  it('returns null when the url is missing or empty', () => {
    expect(normaliseTrengoAttachment({})).toBeNull()
    expect(normaliseTrengoAttachment({ url: '' })).toBeNull()
    expect(normaliseTrengoAttachment({ url: '   ' })).toBeNull()
  })

  it('passes through a fully-specified attachment', () => {
    const out = normaliseTrengoAttachment({
      id: 42,
      url: 'https://app.trengo.com/files/abc.pdf',
      filename: 'invoice.pdf',
      mime_type: 'application/pdf',
      size: 1234,
    })
    expect(out).toEqual({
      id: '42',
      url: 'https://app.trengo.com/files/abc.pdf',
      filename: 'invoice.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 1234,
    })
  })

  it('falls back to content_type when mime_type is absent', () => {
    const out = normaliseTrengoAttachment({
      url: 'https://app.trengo.com/files/img.png',
      filename: 'image.png',
      content_type: 'image/png',
    })
    expect(out?.mimeType).toBe('image/png')
  })

  it('uses application/octet-stream as a last-resort mime', () => {
    const out = normaliseTrengoAttachment({
      url: 'https://app.trengo.com/files/blob',
      filename: 'blob',
    })
    expect(out?.mimeType).toBe('application/octet-stream')
  })

  it('derives the filename from the URL when not provided', () => {
    const out = normaliseTrengoAttachment({
      url: 'https://app.trengo.com/files/some%20doc.pdf',
    })
    expect(out?.filename).toBe('some doc.pdf')
  })

  it('returns null when neither filename nor URL tail is usable', () => {
    expect(
      normaliseTrengoAttachment({ url: 'https://app.trengo.com' }),
    ).toBeNull()
  })

  it('hashes the URL when Trengo did not include an id', () => {
    const a = normaliseTrengoAttachment({
      url: 'https://app.trengo.com/files/x.pdf',
      filename: 'x.pdf',
    })
    const b = normaliseTrengoAttachment({
      url: 'https://app.trengo.com/files/x.pdf',
      filename: 'x.pdf',
    })
    const c = normaliseTrengoAttachment({
      url: 'https://app.trengo.com/files/y.pdf',
      filename: 'y.pdf',
    })
    expect(a?.id).toBe(b?.id)
    expect(a?.id).not.toBe(c?.id)
  })

  it('drops negative or non-number sizes', () => {
    const out = normaliseTrengoAttachment({
      url: 'https://app.trengo.com/files/x',
      filename: 'x',
      size: -1,
    })
    expect(out?.sizeBytes).toBeNull()
  })
})
