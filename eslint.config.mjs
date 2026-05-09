// Flat ESLint config for the StudyMind CRM monorepo.
// Module-boundary rules per CLAUDE.md Section 5.

import { createRequire } from 'node:module'

import js from '@eslint/js'
import tseslint from 'typescript-eslint'

const require = createRequire(import.meta.url)
const requireAuditRule = require('./tools/eslint-rules/require-audit.js')
const registeredEventNamesRule = require('./tools/eslint-rules/registered-event-names.js')

const studymindPlugin = {
  rules: {
    'require-audit': requireAuditRule,
    'registered-event-names': registeredEventNamesRule,
  },
}

export default [
  {
    ignores: [
      '**/node_modules/**',
      '**/.next/**',
      '**/.turbo/**',
      '**/dist/**',
      '**/build/**',
      '**/coverage/**',
      '**/prisma/migrations/**',
      '**/*.generated.ts',
      '**/next-env.d.ts',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // Node-runtime config files (next.config.mjs etc.). Permit `process`.
    files: ['**/*.config.{mjs,cjs,js}'],
    languageOptions: {
      globals: {
        process: 'readonly',
        __dirname: 'readonly',
        require: 'readonly',
        module: 'readonly',
      },
    },
  },
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-explicit-any': 'warn',
    },
  },
  {
    // packages/core may not import from packages/integrations.
    files: ['packages/core/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@studymind/integrations/*', '../integrations/*', '../../integrations/*'],
              message:
                'packages/core is pure domain logic and must not import from packages/integrations.',
            },
          ],
        },
      ],
    },
  },
  {
    // packages/integrations may not import from apps/web.
    files: ['packages/integrations/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@studymind/web', '../../../apps/web/*', '../../../../apps/web/*'],
              message: 'packages/integrations must not import from apps/web.',
            },
          ],
        },
      ],
    },
  },
  {
    // Custom rule: tRPC mutations that write to sensitive models must audit.
    files: ['apps/web/app/api/trpc/routers/**/*.{ts,tsx}'],
    plugins: { studymind: studymindPlugin },
    rules: {
      'studymind/require-audit': 'error',
    },
  },
  {
    // apps/web/app/ must not import @studymind/db directly.
    // RSC pages must read via tRPC server-side helpers or domain functions.
    files: ['apps/web/app/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '@studymind/db',
              message:
                'No direct DB calls in app/. Use tRPC server-side helpers or domain functions in packages/core.',
            },
          ],
        },
      ],
    },
  },
  {
    // CLAUDE.md §45.1: every static event name passed to inngest.send,
    // db.interaction.create, or writeAuditLogEntry must be registered in
    // packages/core/src/events/registry.ts. Dynamic strings are skipped;
    // disable per-line with the documented escape hatch when necessary.
    files: ['packages/**/*.{ts,tsx}', 'apps/**/*.{ts,tsx}'],
    ignores: [
      '**/*.test.ts',
      '**/__tests__/**',
      'packages/core/src/events/registry.ts',
      'tools/**',
    ],
    plugins: { studymind: studymindPlugin },
    rules: {
      'studymind/registered-event-names': 'error',
    },
  },
]
