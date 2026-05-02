// Domain-mapped types for Trengo.
// We never let raw provider types leak into the rest of the app.

export interface TrengoEventEnvelope {
  id: string
  type: string
  receivedAt: Date
}
