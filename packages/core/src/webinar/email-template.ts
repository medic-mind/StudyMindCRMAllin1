// Weekly-class email rendering. Pure string templating with a fixed, documented
// set of {{placeholders}} so the copy stays fully customisable per cohort
// without code changes (CLAUDE.md §4 — warm, specific, action-oriented).

export interface WebinarEmailVars {
  studentName: string
  className: string
  subject: string
  level: string
  cohortName: string
  /** Localised weekday, e.g. "Tuesday". */
  weekday: string
  /** Localised date, e.g. "Tuesday 9 September 2026". */
  dateLabel: string
  /** Localised time, e.g. "18:00 BST". */
  timeLabel: string
  zoomLink: string
  weekNumber: number
  weekTopic: string
  fromName: string
}

export const WEBINAR_PLACEHOLDERS: ReadonlyArray<keyof WebinarEmailVars> = [
  'studentName',
  'className',
  'subject',
  'level',
  'cohortName',
  'weekday',
  'dateLabel',
  'timeLabel',
  'zoomLink',
  'weekNumber',
  'weekTopic',
  'fromName',
]

export const DEFAULT_EMAIL_SUBJECT_TEMPLATE =
  '{{className}} — this week\'s class ({{dateLabel}})'

export const DEFAULT_EMAIL_BODY_TEMPLATE = [
  'Hi {{studentName}},',
  '',
  'Here are the details for this week\'s {{className}} session:',
  '',
  '  • When: {{dateLabel}} at {{timeLabel}}',
  '  • Week {{weekNumber}}: {{weekTopic}}',
  '  • Join here: {{zoomLink}}',
  '',
  'The full term schedule is attached as a PDF. Save the join link — it is the',
  'same each week unless we tell you otherwise.',
  '',
  'See you there,',
  '{{fromName}}',
].join('\n')

/** Replace {{key}} tokens. Unknown tokens are left untouched. */
export function renderTemplate(template: string, vars: WebinarEmailVars): string {
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (whole, key: string) => {
    if (key in vars) {
      return String(vars[key as keyof WebinarEmailVars])
    }
    return whole
  })
}

export interface RenderedWebinarEmail {
  subject: string
  text: string
  /** Rendered HTML body when the cohort supplies an HTML template. */
  html?: string
}

export function renderWebinarEmail(
  subjectTemplate: string,
  bodyTemplate: string,
  vars: WebinarEmailVars,
  htmlTemplate?: string | null,
): RenderedWebinarEmail {
  return {
    subject: renderTemplate(subjectTemplate, vars),
    text: renderTemplate(bodyTemplate, vars),
    ...(htmlTemplate ? { html: renderTemplate(htmlTemplate, vars) } : {}),
  }
}
