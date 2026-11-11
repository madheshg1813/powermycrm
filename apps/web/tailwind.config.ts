import type { Config } from 'tailwindcss';

// Design tokens. Values match Power My Tutor (see docs/DESIGN_SYSTEM.md); do not add colours in pages.
const config: Config = {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        cream: '#F5F1EA',
        ink: { DEFAULT: '#1C1917', soft: '#44403C', muted: '#78716C', faint: '#A8A29E' },
        brand: { DEFAULT: '#EA5A2A', hover: '#D64C1F', soft: '#FDEEE8' },
        green: { DEFAULT: '#168A4C', soft: '#E8F3EA' },
        danger: { DEFAULT: '#B42318', soft: '#FEE4E2' },
        amber: { DEFAULT: '#B54708', soft: '#FEF0C7' },
      },
      fontFamily: {
        sans: ['var(--font-inter)', 'system-ui', 'sans-serif'],
        display: ['var(--font-sora)', 'system-ui', 'sans-serif'],
      },
      boxShadow: {
        soft: '0 1px 2px rgba(28,25,23,0.04), 0 8px 24px -12px rgba(28,25,23,0.12)',
        pop: '0 2px 4px rgba(28,25,23,0.04), 0 16px 32px -16px rgba(28,25,23,0.22)',
      },
    },
  },
  plugins: [],
};

export default config;
