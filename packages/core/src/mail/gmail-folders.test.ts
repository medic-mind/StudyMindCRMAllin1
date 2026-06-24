import { describe, expect, it } from 'vitest'

import {
  buildGmailFolderWhere,
  gmailFolderMatches,
  GMAIL_FOLDERS,
  mutateLabelSet,
  type GmailFolder,
} from './gmail-folders'

describe('gmailFolderMatches', () => {
  it('Inbox = has INBOX', () => {
    expect(gmailFolderMatches(['INBOX', 'UNREAD'], 'inbox')).toBe(true)
    expect(gmailFolderMatches(['SENT'], 'inbox')).toBe(false)
  })

  it('Primary = INBOX without a non-personal category (CATEGORY_PERSONAL stays)', () => {
    expect(gmailFolderMatches(['INBOX', 'CATEGORY_PERSONAL'], 'primary')).toBe(true)
    expect(gmailFolderMatches(['INBOX'], 'primary')).toBe(true)
    expect(gmailFolderMatches(['INBOX', 'CATEGORY_PROMOTIONS'], 'primary')).toBe(false)
    expect(gmailFolderMatches(['INBOX', 'CATEGORY_SOCIAL'], 'primary')).toBe(false)
  })

  it('category tabs require INBOX + the category', () => {
    expect(gmailFolderMatches(['INBOX', 'CATEGORY_PROMOTIONS'], 'promotions')).toBe(true)
    expect(gmailFolderMatches(['INBOX', 'CATEGORY_SOCIAL'], 'social')).toBe(true)
    expect(gmailFolderMatches(['INBOX', 'CATEGORY_UPDATES'], 'updates')).toBe(true)
    expect(gmailFolderMatches(['INBOX', 'CATEGORY_FORUMS'], 'forums')).toBe(true)
    // A promotions email that has been archived (no INBOX) is not in the tab.
    expect(gmailFolderMatches(['CATEGORY_PROMOTIONS'], 'promotions')).toBe(false)
  })

  it('Spam / Trash are their own boxes and hide from everything else', () => {
    expect(gmailFolderMatches(['SPAM'], 'spam')).toBe(true)
    expect(gmailFolderMatches(['TRASH'], 'trash')).toBe(true)
    // All Mail excludes Spam + Trash (Gmail behaviour).
    expect(gmailFolderMatches(['SPAM'], 'all')).toBe(false)
    expect(gmailFolderMatches(['TRASH'], 'all')).toBe(false)
    expect(gmailFolderMatches(['SENT'], 'all')).toBe(true)
    // Starred/important exclude trashed + spam.
    expect(gmailFolderMatches(['STARRED', 'TRASH'], 'starred')).toBe(false)
    expect(gmailFolderMatches(['IMPORTANT', 'SPAM'], 'important')).toBe(false)
    expect(gmailFolderMatches(['STARRED', 'INBOX'], 'starred')).toBe(true)
  })

  it('Sent / Important / Snoozed map to their labels', () => {
    expect(gmailFolderMatches(['SENT'], 'sent')).toBe(true)
    expect(gmailFolderMatches(['SENT', 'TRASH'], 'sent')).toBe(false)
    expect(gmailFolderMatches(['IMPORTANT', 'INBOX'], 'important')).toBe(true)
    expect(gmailFolderMatches(['SNOOZED'], 'snoozed')).toBe(true)
  })

  it('Archived = not in Inbox/Spam/Trash', () => {
    expect(gmailFolderMatches(['SENT'], 'archived')).toBe(true)
    expect(gmailFolderMatches(['INBOX'], 'archived')).toBe(false)
    expect(gmailFolderMatches(['SPAM'], 'archived')).toBe(false)
    expect(gmailFolderMatches(['TRASH'], 'archived')).toBe(false)
  })

  it('Unread requires UNREAD and excludes spam/trash', () => {
    expect(gmailFolderMatches(['INBOX', 'UNREAD'], 'unread')).toBe(true)
    expect(gmailFolderMatches(['UNREAD', 'SPAM'], 'unread')).toBe(false)
    expect(gmailFolderMatches(['INBOX'], 'unread')).toBe(false)
  })
})

describe('buildGmailFolderWhere', () => {
  it('OR-combines a label branch (synced) and a legacy branch (empty labels)', () => {
    const where = buildGmailFolderWhere('inbox')
    expect(where).toHaveProperty('OR')
    const branches = (where as { OR: unknown[] }).OR
    expect(branches).toHaveLength(2)
    // Label branch excludes empty-label rows so a healed head is matched once.
    const labelBranch = JSON.stringify(branches[0])
    expect(labelBranch).toContain('isEmpty')
    expect(labelBranch).toContain('INBOX')
    // Legacy branch gates on empty labels + the old status predicate.
    const legacyBranch = JSON.stringify(branches[1])
    expect(legacyBranch).toContain('"status":"open"')
  })

  it('Gmail-native folders without a legacy meaning have only the label branch', () => {
    for (const f of ['sent', 'important', 'social', 'snoozed'] as GmailFolder[]) {
      const where = buildGmailFolderWhere(f)
      expect((where as { OR: unknown[] }).OR).toHaveLength(1)
    }
  })

  it('builds a fragment for every declared folder', () => {
    for (const f of GMAIL_FOLDERS) {
      const where = buildGmailFolderWhere(f)
      expect(where).toHaveProperty('OR')
    }
  })
})

describe('mutateLabelSet', () => {
  it('archives by removing INBOX and stars by adding STARRED', () => {
    expect(mutateLabelSet(['INBOX', 'UNREAD'], { remove: ['INBOX'] })).toEqual(['UNREAD'])
    expect(mutateLabelSet(['INBOX'], { add: ['STARRED'] })).toEqual(['INBOX', 'STARRED'])
  })

  it('trash adds TRASH and drops INBOX in one delta', () => {
    expect(mutateLabelSet(['INBOX', 'IMPORTANT'], { add: ['TRASH'], remove: ['INBOX'] })).toEqual([
      'IMPORTANT',
      'TRASH',
    ])
  })

  it('is idempotent and de-duplicates', () => {
    expect(mutateLabelSet(['INBOX', 'INBOX'], { add: ['INBOX'] })).toEqual(['INBOX'])
    expect(mutateLabelSet(['INBOX'], { remove: ['SENT'] })).toEqual(['INBOX'])
  })
})
