// Authenticated SDK client factory for GoCardless.

export interface GocardlessClient {
  readonly baseUrl: string
}

export function createClient(): GocardlessClient {
  throw new Error('not implemented')
}
