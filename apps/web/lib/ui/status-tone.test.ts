import { describe, expect, it } from 'vitest'

import { callOutcomeTone, riskLabel, riskTone } from './status-tone'

describe('status-tone', () => {
  it('maps hours-risk level to a shared badge tone + label', () => {
    expect(riskTone('high')).toBe('danger')
    expect(riskTone('medium')).toBe('warn')
    expect(riskTone('low')).toBe('neutral')
    expect(riskTone('none')).toBe('neutral')

    expect(riskLabel('high')).toBe('High risk')
    expect(riskLabel('medium')).toBe('At risk')
    expect(riskLabel('low')).toBe('Watch')
    expect(riskLabel('none')).toBe('')
  })

  it('maps call outcome to one tone regardless of caller (no more green-vs-emerald drift)', () => {
    expect(callOutcomeTone('answered')).toBe('success')
    expect(callOutcomeTone('voicemail')).toBe('warn')
    expect(callOutcomeTone('missed')).toBe('danger')
    expect(callOutcomeTone('no_answer')).toBe('danger')
    expect(callOutcomeTone('unknown')).toBe('neutral')
  })
})
