// Tests for the deterministic Slack contact-signal extractor — the free
// route that runs before any AI spend (§32).

import { describe, expect, it } from 'vitest'

import { extractContactSignals, slackTextToPlain } from './extract'

describe('slackTextToPlain', () => {
  it('unwraps tel/mailto/url markup and strips mentions', () => {
    expect(
      slackTextToPlain(
        'Leisha Burgess <tel:+447359988992|+447359988992> Medic Mind <@U123> see <https://x.com|the site>',
      ),
    ).toBe('Leisha Burgess +447359988992 Medic Mind see the site')
  })
})

describe('extractContactSignals', () => {
  it('reads a Slack-linked phone (the call-log format)', () => {
    const s = extractContactSignals(
      '🇬🇧Leisha Burgess <tel:+447359988992|+447359988992> Medic Mind\nCurrently doing a course',
    )
    expect(s.phone).toBe('+447359988992')
  })

  it('reads a plain-text phone and email', () => {
    const s = extractContactSignals('Fernando Arango +1 203 604-7609 fern@example.com IMAT')
    expect(s.phone).toBe('+12036047609')
    expect(s.email).toBe('fern@example.com')
  })

  it('reads mailto markup', () => {
    expect(extractContactSignals('<mailto:Parent@Example.com|Parent@Example.com>').email).toBe(
      'parent@example.com',
    )
  })

  it('ignores short digit runs (prices, order ids)', () => {
    expect(extractContactSignals('charged £30-40ph for 12345678').phone).toBeNull()
  })

  it('returns nulls when nothing is present', () => {
    expect(extractContactSignals('can someone check the rota?')).toEqual({
      email: null,
      phone: null,
    })
  })
})
