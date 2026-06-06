import { describe, expect, it } from 'vitest'

import {
  DEFAULT_EMAIL_BODY_TEMPLATE,
  DEFAULT_EMAIL_SUBJECT_TEMPLATE,
  renderTemplate,
  renderWebinarEmail,
  type WebinarEmailVars,
} from './email-template'

const vars: WebinarEmailVars = {
  studentName: 'Sam',
  className: 'Biology A-Level',
  subject: 'Biology',
  level: 'A-Level',
  cohortName: '2026/2027',
  weekday: 'Tuesday',
  dateLabel: 'Tuesday 9 September 2026',
  timeLabel: '18:00 BST',
  zoomLink: 'https://zoom.us/j/123',
  weekNumber: 1,
  weekTopic: 'Cell structure',
  fromName: 'StudyMind',
}

describe('renderTemplate', () => {
  it('substitutes known placeholders', () => {
    expect(renderTemplate('Hi {{studentName}} — {{weekTopic}}', vars)).toBe('Hi Sam — Cell structure')
  })

  it('leaves unknown placeholders untouched', () => {
    expect(renderTemplate('{{unknown}}', vars)).toBe('{{unknown}}')
  })

  it('tolerates whitespace inside the braces', () => {
    expect(renderTemplate('{{ zoomLink }}', vars)).toBe('https://zoom.us/j/123')
  })
})

describe('renderWebinarEmail (defaults)', () => {
  it('produces a subject and body with the key details', () => {
    const out = renderWebinarEmail(DEFAULT_EMAIL_SUBJECT_TEMPLATE, DEFAULT_EMAIL_BODY_TEMPLATE, vars)
    expect(out.subject).toContain('Biology A-Level')
    expect(out.subject).toContain('Tuesday 9 September 2026')
    expect(out.text).toContain('https://zoom.us/j/123')
    expect(out.text).toContain('Week 1: Cell structure')
    expect(out.text).toContain('Sam')
  })
})
