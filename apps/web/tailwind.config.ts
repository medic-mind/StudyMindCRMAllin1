import type { Config } from 'tailwindcss'
import { colors, radius, spacing, typography } from '@studymind/ui/tokens'

const config: Config = {
  content: [
    './app/**/*.{ts,tsx}',
    './components/**/*.{ts,tsx}',
    './lib/**/*.{ts,tsx}',
    '../../packages/ui/src/**/*.{ts,tsx}',
  ],
  theme: {
    extend: {
      colors: {
        primary: colors.primary,
        secondary: colors.secondary,
        neutral: colors.neutral,
        success: colors.success,
        warning: colors.warning,
        danger: colors.danger,
        info: colors.info,
      },
      fontFamily: typography.fontFamily,
      letterSpacing: typography.letterSpacing,
      fontWeight: typography.fontWeight,
      borderRadius: radius,
      spacing,
    },
  },
  plugins: [],
}

export default config
