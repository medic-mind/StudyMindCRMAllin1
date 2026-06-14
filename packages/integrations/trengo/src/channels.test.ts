import { describe, expect, it } from 'vitest'

import { normaliseTrengoChannel } from './channels'

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
