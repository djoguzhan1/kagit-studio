/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['"Plus Jakarta Sans"', 'system-ui', '-apple-system', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'ui-monospace', 'SFMono-Regular', 'monospace'],
      },
      colors: {
        desk: {
          bg: 'rgb(var(--desk-bg-rgb) / <alpha-value>)',
          surface: 'rgb(var(--desk-surface-rgb) / <alpha-value>)',
          panel: 'rgb(var(--desk-panel-rgb) / <alpha-value>)',
          well: 'rgb(var(--desk-well-rgb) / <alpha-value>)',
          border: 'rgb(var(--desk-border-rgb) / <alpha-value>)',
          text: 'rgb(var(--desk-text-rgb) / <alpha-value>)',
          muted: 'rgb(var(--desk-muted-rgb) / <alpha-value>)',
        },
        ink: {
          vermilion: 'rgb(var(--ink-vermilion-rgb) / <alpha-value>)',
          blue: '#2563EB',
          rose: '#E11D48',
          brass: 'rgb(var(--ink-brass-rgb) / <alpha-value>)',
          brassBright: '#D99B26',
          emerald: '#16A34A',
        },
      },
    },
  },
  plugins: [],
};
