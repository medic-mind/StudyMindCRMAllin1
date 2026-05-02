// Domain-mapped types for Booking site.
// We never let raw provider types leak into the rest of the app.

export interface BookingEventEnvelope {
  id: string
  type: string
  receivedAt: Date
}
