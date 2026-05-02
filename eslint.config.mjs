// Flat ESLint config for the StudyMind CRM monorepo.
// Module-boundary rules per CLAUDE.md Section 5.

import js from '@eslint/js'
import tseslint from 'typescript-eslint'

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
]
