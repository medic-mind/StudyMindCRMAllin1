// Authenticated SDK client factory for Trengo.

export interface TrengoClient {
  readonly baseUrl: string
}

export function createClient(): TrengoClient {
  throw new Error('not implemented')
}
