import { describe, expect, it } from 'vitest'

import {
  callOutcomeTone,
  complaintStatusTone,
  contactKindTone,
  paymentStatusTone,
  riskLabel,
  riskTone,
} from './status-tone'

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

  it('maps finance payment/refund/link status to one shared tone', () => {
    expect(paymentStatusTone('succeeded')).toBe('success')
    expect(paymentStatusTone('completed')).toBe('success')
    expect(paymentStatusTone('pending')).toBe('warn')
    expect(paymentStatusTone('pending_review')).toBe('warn')
    expect(paymentStatusTone('created')).toBe('info')
    expect(paymentStatusTone('failed')).toBe('danger')
    expect(paymentStatusTone('cancelled')).toBe('danger')
    expect(paymentStatusTone('expired')).toBe('neutral')
  })

  it('maps contact kind + complaint status consistently', () => {
    expect(contactKindTone('parent')).toBe('info')
    expect(contactKindTone('student')).toBe('accent')
    expect(contactKindTone('tutor')).toBe('success')
    expect(contactKindTone('other')).toBe('neutral')

    expect(complaintStatusTone('open')).toBe('danger')
    expect(complaintStatusTone('in_progress')).toBe('info')
    expect(complaintStatusTone('resolved')).toBe('success')
    expect(complaintStatusTone('dismissed')).toBe('neutral')
  })
})
