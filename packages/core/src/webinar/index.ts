// @studymind/core/webinar — pure domain for the weekly-class auto-enrollment
// system: subject/level matching, holiday-aware scheduling, email templating,
// and the generated schedule PDF. No I/O; the tRPC router and Inngest jobs
// supply the data and perform the writes.

export * from './types'
export * from './matching'
export * from './schedule'
export * from './format'
export * from './email-template'
export * from './pdf'
export * from './timetable'
