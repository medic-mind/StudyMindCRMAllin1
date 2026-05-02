// Re-export of the Prisma client singleton for use inside apps/web/lib and
// apps/web/app/api/webhooks (where we orchestrate, not query). RSC pages and
// app routes still go through tRPC server-side helpers or domain functions.

export { db } from '@studymind/db'
