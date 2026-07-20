import { describe, expect, it } from 'vitest'

import {
  bodyToPlainText,
  extractMentionUserIds,
  extractRefs,
  mentionToken,
  refToken,
  tokenizeChatBody,
} from './parse'

describe('tokenizeChatBody', () => {
  it('returns a single text token for plain text', () => {
    expect(tokenizeChatBody('hello world')).toEqual([{ kind: 'text', text: 'hello world' }])
  })

  it('parses a mention surrounded by text', () => {
    const tokens = tokenizeChatBody('hey <@abc123> can you look?')
    expect(tokens).toEqual([
      { kind: 'text', text: 'hey ' },
      { kind: 'mention', userId: 'abc123' },
      { kind: 'text', text: ' can you look?' },
    ])
  })

  it('parses an entity reference', () => {
    const tokens = tokenizeChatBody('see <~contact:c_1> please')
    expect(tokens).toEqual([
      { kind: 'text', text: 'see ' },
      { kind: 'ref', refType: 'contact', refId: 'c_1' },
      { kind: 'text', text: ' please' },
    ])
  })

  it('parses all ref types (incl. legacy task)', () => {
    const body = '<~contact:a> <~family:b> <~card:c> <~task:d>'
    const refs = tokenizeChatBody(body).filter((t) => t.kind === 'ref')
    expect(refs).toEqual([
      { kind: 'ref', refType: 'contact', refId: 'a' },
      { kind: 'ref', refType: 'family', refId: 'b' },
      { kind: 'ref', refType: 'card', refId: 'c' },
      { kind: 'ref', refType: 'task', refId: 'd' },
    ])
  })

  it('round-trips losslessly (joining text/labels reproduces structure)', () => {
    const body = 'a <@u1> b <~card:k9> c'
    const rebuilt = tokenizeChatBody(body)
      .map((t) =>
        t.kind === 'text'
          ? t.text
          : t.kind === 'mention'
            ? `<@${t.userId}>`
            : `<~${t.refType}:${t.refId}>`,
      )
      .join('')
    expect(rebuilt).toBe(body)
  })

  it('treats an unknown ref type as plain text', () => {
    // `tutor` is not a valid ChatRefType, so the token stays literal text.
    expect(tokenizeChatBody('<~tutor:x>')).toEqual([{ kind: 'text', text: '<~tutor:x>' }])
  })

  it('handles adjacent tokens with no separating text', () => {
    expect(tokenizeChatBody('<@u1><@u2>')).toEqual([
      { kind: 'mention', userId: 'u1' },
      { kind: 'mention', userId: 'u2' },
    ])
  })

  it('accepts seeded ids with hyphens', () => {
    expect(tokenizeChatBody('<~contact:seed-chat-general>')).toEqual([
      { kind: 'ref', refType: 'contact', refId: 'seed-chat-general' },
    ])
  })
})

describe('extractMentionUserIds', () => {
  it('returns distinct ids in first-seen order', () => {
    expect(extractMentionUserIds('<@a> hi <@b> <@a>')).toEqual(['a', 'b'])
  })

  it('returns an empty array when there are no mentions', () => {
    expect(extractMentionUserIds('no mentions here')).toEqual([])
  })
})

describe('extractRefs', () => {
  it('dedupes by type+id and preserves order', () => {
    expect(extractRefs('<~contact:1> <~family:1> <~contact:1>')).toEqual([
      { type: 'contact', id: '1' },
      { type: 'family', id: '1' },
    ])
  })
})

describe('token encoders', () => {
  it('mentionToken / refToken produce parseable output', () => {
    const body = `${mentionToken('u9')} ${refToken('card', 't3')}`
    expect(extractMentionUserIds(body)).toEqual(['u9'])
    expect(extractRefs(body)).toEqual([{ type: 'card', id: 't3' }])
  })
})

describe('bodyToPlainText', () => {
  it('replaces tokens with readable labels', () => {
    const body = 'ping <@u1> about <~family:f1>'
    const text = bodyToPlainText(body, { u1: 'Alex Doe', f1: 'Smith Family' })
    expect(text).toBe('ping @Alex Doe about #Smith Family')
  })

  it('falls back to placeholders when a name is missing', () => {
    expect(bodyToPlainText('<@u1> <~card:c1>')).toBe('@someone #card')
  })
})
