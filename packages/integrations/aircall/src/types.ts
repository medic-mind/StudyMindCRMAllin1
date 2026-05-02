// Domain-mapped types for Aircall.
// We never let raw provider types leak into the rest of the app.

export interface AircallEventEnvelope {
  id: string
  type: string
  receivedAt: Date
}
