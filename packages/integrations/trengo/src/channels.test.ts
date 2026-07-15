import { describe, expect, it } from 'vitest'

import { cleanChannelName, normaliseTrengoChannel } from './channels'

describe('normaliseTrengoChannel', () => {
  it('maps a WhatsApp Business channel to our kind + keeps the name', () => {
    expect(normaliseTrengoChannel({ id: 7, name: 'Support Manager', type: 'WA_BUSINESS' })).toEqual({
      trengoId: 7,
      name: 'Support Manager',
      trengoType: 'WA_BUSINESS',
      channelType: 'whatsapp',
    })
  })

  it('keeps an unknown type with a null kind (still shows by name)', () => {
    const c = normaliseTrengoChannel({ id: 8, name: 'FB Page', type: 'FACEBOOK' })
    expect(c?.channelType).toBeNull()
    expect(c?.name).toBe('FB Page')
  })

  it('trims a blank name to null and rejects rows with no id', () => {
    expect(normaliseTrengoChannel({ id: 9, name: '   ', type: 'EMAIL' })?.name).toBeNull()
    expect(normaliseTrengoChannel({ name: 'x' })).toBeNull()
    expect(normaliseTrengoChannel(null)).toBeNull()
  })
})


describe('cleanChannelName', () => {
  it('always rejects machine tags however cased/spaced', () => {
    expect(cleanChannelName('Wa_business')).toBeNull()
    expect(cleanChannelName('WA_BUSINESS')).toBeNull()
    expect(cleanChannelName('Web chat')).toBeNull()
    expect(cleanChannelName('Help Center')).toBeNull()
  })

  it('rejects a generic word only when it matches the channel OWN type', () => {
    expect(cleanChannelName('Email', 'EMAIL')).toBeNull()
    expect(cleanChannelName('Sms', 'SMS')).toBeNull()
    expect(cleanChannelName('Chat', 'CHAT')).toBeNull()
    expect(cleanChannelName('Whatsapp', 'WA_BUSINESS')).toBeNull()
    // …but a channel GENUINELY named like another type is preserved.
    expect(cleanChannelName('Facebook', 'WA_BUSINESS')).toBe('Facebook')
    expect(cleanChannelName('Email', 'WA_BUSINESS')).toBe('Email')
  })

  it('keeps real names and identifiers', () => {
    expect(cleanChannelName('Study Mind Support', 'WA_BUSINESS')).toBe('Study Mind Support')
    expect(cleanChannelName('+447453918086', 'WA_BUSINESS')).toBe('+447453918086')
    expect(cleanChannelName('  ', 'SMS')).toBeNull()
    expect(cleanChannelName(null)).toBeNull()
  })
})

describe('normaliseTrengoChannel — name fallbacks', () => {
  it('falls through name candidates to the line identity', () => {
    expect(
      normaliseTrengoChannel({ id: 9, name: 'WA_BUSINESS', type: 'WA_BUSINESS', phone: '+4474' }),
    ).toEqual({ trengoId: 9, name: '+4474', trengoType: 'WA_BUSINESS', channelType: 'whatsapp' })
  })

  it('yields null name when nothing but the type tag exists', () => {
    expect(normaliseTrengoChannel({ id: 9, name: 'EMAIL', type: 'EMAIL' })?.name).toBeNull()
  })
})
