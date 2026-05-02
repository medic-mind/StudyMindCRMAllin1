/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  transpilePackages: [
    '@studymind/audit',
    '@studymind/core',
    '@studymind/db',
    '@studymind/integration-aircall',
    '@studymind/integration-asana',
    '@studymind/integration-booking',
    '@studymind/integration-gmail',
    '@studymind/integration-gocardless',
    '@studymind/integration-slack',
    '@studymind/integration-stripe',
    '@studymind/integration-trengo',
    '@studymind/jobs',
    '@studymind/ui',
  ],
  experimental: {
    typedRoutes: false,
  },
}

export default nextConfig
