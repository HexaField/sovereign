import type { Config } from 'tailwindcss'

export default {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      animation: {
        'mic-pulse': 'mic-pulse 1.5s infinite',
        'voice-pulse': 'voice-pulse 2s infinite',
        'speak-pulse': 'speak-pulse 1.5s infinite',
        'pulse-dots': 'pulse-dots 1.5s ease-in-out infinite',
        march: 'march 0.5s linear infinite',
        'warning-pulse': 'warning-pulse 1.5s ease-in-out infinite',
        spin: 'spin 0.6s linear infinite'
      },
      colors: {
        'c-accent': 'var(--c-accent)',
        'c-danger': 'var(--c-danger)',
        'c-amber': 'var(--c-amber)',
        'c-text': 'var(--c-text)',
        'c-text-muted': 'var(--c-text-muted)'
      }
    }
  }
} satisfies Config
