// Authenticated SDK client factory for Slack.

export interface SlackClient {
  readonly baseUrl: string
}

export function createClient(): SlackClient {
  throw new Error('not implemented')
}
