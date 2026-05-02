// Authenticated SDK client factory for Gmail.

export interface GmailClient {
  readonly baseUrl: string
}

export function createClient(): GmailClient {
  throw new Error('not implemented')
}
