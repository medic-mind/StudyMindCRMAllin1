// Friendly reminder-email building blocks for the group editor (client-safe — no
// node/core imports so it can live in the bundle). The merge fields use the same
// {{token}} names as @studymind/core WebinarEmailVars, so what the chip editor
// produces is rendered identically by the dispatcher.

import type { RichTextField } from '@/components/ui/rich-text-editor'

/** Merge fields offered as labelled chips in the editor (never raw tokens). */
export const REMINDER_FIELDS: RichTextField[] = [
  { token: '{{studentName}}', label: 'Student name' },
  { token: '{{className}}', label: 'Class name' },
  { token: '{{dateLabel}}', label: 'Date' },
  { token: '{{timeLabel}}', label: 'Time' },
  { token: '{{weekNumber}}', label: 'Week number' },
  { token: '{{weekTopic}}', label: 'Topic' },
  { token: '{{zoomLink}}', label: 'Zoom link' },
  { token: '{{fromName}}', label: 'Sign-off' },
]

export interface ReminderPreset {
  id: string
  name: string
  description: string
  subject: string
  bodyHtml: string
}

/** Pre-made templates staff can start from, then tweak in the editor. */
export const REMINDER_PRESETS: ReminderPreset[] = [
  {
    id: 'friendly',
    name: 'Friendly',
    description: 'Warm, with the week’s topic and join link.',
    subject: '{{className}} — this week’s class ({{dateLabel}})',
    bodyHtml: [
      '<p>Hi {{studentName}},</p>',
      '<p>Here are the details for this week’s <strong>{{className}}</strong> class:</p>',
      '<ul>',
      '<li><strong>When:</strong> {{dateLabel}} at {{timeLabel}}</li>',
      '<li><strong>Week {{weekNumber}}:</strong> {{weekTopic}}</li>',
      '<li><strong>Join here:</strong> {{zoomLink}}</li>',
      '</ul>',
      '<p>The full term schedule is attached. See you there!</p>',
      '<p>{{fromName}}</p>',
    ].join('\n'),
  },
  {
    id: 'concise',
    name: 'Concise',
    description: 'Just the essentials — time, topic, link.',
    subject: 'Your {{className}} class — {{dateLabel}}',
    bodyHtml: [
      '<p>Hi {{studentName}},</p>',
      '<p>This week’s <strong>{{className}}</strong> class (week {{weekNumber}}: {{weekTopic}}) is on {{dateLabel}} at {{timeLabel}}.</p>',
      '<p>Join here: {{zoomLink}}</p>',
      '<p>{{fromName}}</p>',
    ].join('\n'),
  },
  {
    id: 'detailed',
    name: 'Detailed',
    description: 'Adds a “what we’ll cover” line and a reminder to be on time.',
    subject: '{{className}}: Week {{weekNumber}} — {{weekTopic}}',
    bodyHtml: [
      '<p>Hi {{studentName}},</p>',
      '<p>Looking forward to seeing you at this week’s <strong>{{className}}</strong> class.</p>',
      '<ul>',
      '<li><strong>Date:</strong> {{dateLabel}}</li>',
      '<li><strong>Time:</strong> {{timeLabel}} (please join a few minutes early)</li>',
      '<li><strong>This week (week {{weekNumber}}):</strong> {{weekTopic}}</li>',
      '<li><strong>Zoom link:</strong> {{zoomLink}}</li>',
      '</ul>',
      '<p>The full term schedule is attached so you can see what’s coming up.</p>',
      '<p>See you there,<br>{{fromName}}</p>',
    ].join('\n'),
  },
]

export type PreviewVars = Record<string, string>

/** Replace {{token}}s. Unknown tokens are left as-is. Mirrors core renderTemplate. */
export function renderTokens(template: string, vars: PreviewVars): string {
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (whole, key: string) =>
    key in vars ? vars[key]! : whole,
  )
}

const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']

interface PreviewSource {
  subjectLabel: string
  levelLabel: string
  cohortName: string
  dayOfWeek: number
  zoomLink: string | null
  currentWeek: {
    weekNumber: number | null
    dateLabel: string | null
    timeLabel: string | null
    topic: string
  }
}

/** Build live-preview values from the group's real next-session data, falling
 *  back to sensible samples when the term hasn't started / has ended. */
export function buildPreviewVars(d: PreviewSource): PreviewVars {
  const className = `${d.subjectLabel} ${d.levelLabel}`.trim()
  return {
    studentName: 'Sam',
    className,
    subject: d.subjectLabel,
    level: d.levelLabel,
    cohortName: d.cohortName,
    weekday: WEEKDAYS[d.dayOfWeek] ?? '',
    dateLabel: d.currentWeek.dateLabel ?? 'Saturday 13 September 2026',
    timeLabel: d.currentWeek.timeLabel ?? '18:00',
    zoomLink: d.zoomLink ?? 'https://zoom.us/j/your-link',
    weekNumber: String(d.currentWeek.weekNumber ?? 1),
    weekTopic: d.currentWeek.topic || 'This week’s topic',
    fromName: 'The StudyMind team',
  }
}
