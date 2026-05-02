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
      fontFamily: {
        sans: [...typography.fontFamily.sans],
        mono: [...typography.fontFamily.mono],
      },
      letterSpacing: { ...typography.letterSpacing },
      fontWeight: { ...typography.fontWeight },
      borderRadius: radius,
      spacing,
    },
  },
  plugins: [],
}

export default config
