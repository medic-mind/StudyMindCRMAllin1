// Shared comment-thread types. Used by both card threads (slice A) and task
// threads (slice B). Comments persist as Interactions on the backing Contact,
// but the thread UI only needs this view-model shape.

export interface ThreadComment {
  id: string
  body: string
  authorId: string | null
  authorName: string | null
  /** ISO string or Date — the component normalises to a Date for display. */
  occurredAt: string | Date
}
