import type { Metadata } from 'next'
import { Inter } from 'next/font/google'

import { ChunkReloader } from '@/components/shell/chunk-reloader'
import { AppToaster } from '@/components/ui/app-toaster'
import { TrpcProvider } from '@/lib/trpc/Provider'

import './globals.css'

// Inter is what the tokens already advertise (packages/ui/tokens/typography.ts);
// loading it here makes the rest of the stack actually render in Inter instead
// of falling back to system-ui. `variable` lets globals.css reference it.
const inter = Inter({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-sans',
})

export const metadata: Metadata = {
  title: 'StudyMind CRM',
  description: 'StudyMind All in One CRM',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en-GB" className={inter.variable}>
      <body>
        {/* Recovers from stale-chunk blank screens after a deploy (full reload,
            hard-capped). Must sit above the app so it's live before route
            chunks load. */}
        <ChunkReloader />
        <TrpcProvider>{children}</TrpcProvider>
        {/* Bottom-right, light, auto-dismissing — the single audited
            notification surface. Styling + rationale live in AppToaster. */}
        <AppToaster />
      </body>
    </html>
  )
}
