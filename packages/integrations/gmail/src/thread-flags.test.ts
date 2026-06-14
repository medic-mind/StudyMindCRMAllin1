import { describe, expect, it } from 'vitest'

import { deriveThreadFlags, DELETED_THREAD_FLAGS } from './thread-flags'

describe('deriveThreadFlags', () => {
  it('an inbox thread that has been read', () => {
    expect(deriveThreadFlags(['INBOX'])).toEqual({
      isRead: true,
      isStarred: false,
      isArchived: false,
      isTrashed: false,
    })
  })

  it('UNREAD => not read', () => {
    expect(deriveThreadFlags(['INBOX', 'UNREAD']).isRead).toBe(false)
  })

  it('STARRED => starred', () => {
    expect(deriveThreadFlags(['INBOX', 'STARRED']).isStarred).toBe(true)
  })

  it('no INBOX and no TRASH => archived', () => {
    const f = deriveThreadFlags(['IMPORTANT'])
    expect(f.isArchived).toBe(true)
    expect(f.isTrashed).toBe(false)
  })

  it('TRASH wins over archive — trashed, not archived', () => {
    const f = deriveThreadFlags(['TRASH'])
    expect(f.isTrashed).toBe(true)
    expect(f.isArchived).toBe(false)
  })

  it('TRASH alongside a stale INBOX label still reads as trashed only', () => {
    const f = deriveThreadFlags(['INBOX', 'TRASH'])
    expect(f.isTrashed).toBe(true)
    expect(f.isArchived).toBe(false)
  })

  it('empty label set => archived + read (no inbox, no unread, no trash)', () => {
    expect(deriveThreadFlags([])).toEqual({
      isRead: true,
      isStarred: false,
      isArchived: true,
      isTrashed: false,
    })
  })

  it('custom labels are ignored for system flags', () => {
    const f = deriveThreadFlags(['INBOX', 'UNREAD', 'STARRED', 'Label_42'])
    expect(f).toEqual({
      isRead: false,
      isStarred: true,
      isArchived: false,
      isTrashed: false,
    })
  })

  it('deleted-thread fallback is trashed + read', () => {
    expect(DELETED_THREAD_FLAGS).toEqual({
      isRead: true,
      isStarred: false,
      isArchived: false,
      isTrashed: true,
    })
  })
})
