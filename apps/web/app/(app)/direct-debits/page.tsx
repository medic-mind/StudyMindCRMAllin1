// Direct Debits — master dashboard (ADR 0038). Top-level nav section; the
// working tabs live at /direct-debits/<tab>.

import { DirectDebitsPage } from './workspace-page'

export const dynamic = 'force-dynamic'

export default function Page(): Promise<JSX.Element> {
  return DirectDebitsPage({ tab: 'overview' })
}
