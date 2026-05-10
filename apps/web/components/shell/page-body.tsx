// Standard padded container that sits below a `<PageHeader>`. Most pages
// look like:
//
//   <>
//     <PageHeader title="…" />
//     <PageBody>{content}</PageBody>
//   </>
//
// A separate component avoids the padding being baked into PageHeader so
// the header can run flush across the surface while content stays
// comfortably padded. CLAUDE.md §26 (RSC by default).

import type { ReactNode } from 'react'

export function PageBody({ children }: { children: ReactNode }) {
  // The (app) shell already pads children with px-6 py-6; this component
  // exists as an explicit semantic marker for the body region so future
  // density toggles can target it. For now it renders as a fragment.
  return <>{children}</>
}
