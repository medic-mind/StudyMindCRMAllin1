import { describe, expect, it } from 'vitest'

import { buildSlackPermalink } from './permalink'

describe('buildSlackPermalink', () => {
  it('builds the archives URL with the dot stripped from ts', () => {
    expect(buildSlackPermalink('C0123', '1718000000.123456')).toBe(
      'https://slack.com/archives/C0123/p1718000000123456',
    )
  })

  it('links thread replies into their thread', () => {
    expect(buildSlackPermalink('C0123', '1718000001.000200', '1718000000.123456')).toBe(
      'https://slack.com/archives/C0123/p1718000001000200?thread_ts=1718000000.123456&cid=C0123',
    )
  })

  it('treats a thread parent (thread_ts === ts) as a plain message', () => {
    expect(buildSlackPermalink('C0123', '1718000000.123456', '1718000000.123456')).toBe(
      'https://slack.com/archives/C0123/p1718000000123456',
    )
  })
})
