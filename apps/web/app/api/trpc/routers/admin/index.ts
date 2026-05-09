// Admin namespace: users, roles, flags, integrations status.
// All procedures here gate on `admin` (or admin|ops_manager for read-only).

import { router } from '@/lib/trpc/builders'

import { adminFlagsRouter } from './flags'
import { adminUsersRouter } from './users'

export const adminRouter = router({
  flags: adminFlagsRouter,
  users: adminUsersRouter,
})
