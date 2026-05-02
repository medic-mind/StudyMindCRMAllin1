// Domain-mapped types for Gmail.
// We never let raw provider types leak into the rest of the app.

export interface GmailEventEnvelope {
  id: string
  type: string
  receivedAt: Date
}
