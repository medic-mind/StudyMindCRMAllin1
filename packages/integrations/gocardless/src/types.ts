// Domain-mapped types for GoCardless.
// We never let raw provider types leak into the rest of the app.

export interface GocardlessEventEnvelope {
  id: string
  type: string
  receivedAt: Date
}
