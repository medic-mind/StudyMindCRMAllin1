// Authenticated SDK client factory for Asana.

export interface AsanaClient {
  readonly baseUrl: string
}

export function createClient(): AsanaClient {
  throw new Error('not implemented')
}
