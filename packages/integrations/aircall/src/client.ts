// Authenticated SDK client factory for Aircall.

export interface AircallClient {
  readonly baseUrl: string
}

export function createClient(): AircallClient {
  throw new Error('not implemented')
}
