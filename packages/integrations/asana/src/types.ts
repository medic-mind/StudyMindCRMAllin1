// Domain-mapped types for Asana.
// We never let raw provider types leak into the rest of the app.

export interface AsanaEventEnvelope {
  id: string
  type: string
  receivedAt: Date
}
