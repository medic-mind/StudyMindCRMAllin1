// Authenticated SDK client factory for Booking site.

export interface BookingClient {
  readonly baseUrl: string
}

export function createClient(): BookingClient {
  throw new Error('not implemented')
}
