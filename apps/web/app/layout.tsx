import type { Metadata } from 'next'
import { Inter } from 'next/font/google'
import { Toaster } from 'sonner'

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
        <TrpcProvider>{children}</TrpcProvider>
        {/* Top-centre, dismissable, 5s — action confirmations must be
            impossible to miss while the agent's eyes are mid-page. */}
        <Toaster richColors position="top-center" closeButton duration={5000} />
      </body>
    </html>
  )
}
