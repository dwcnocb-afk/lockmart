import type { Config } from 'tailwindcss'

const config: Config = {
  // The app is dark-only. Forcing the class keeps every `dark:` utility active
  // regardless of the visitor's OS theme (previously light-OS users saw
  // unreadable gray-on-dark text on the sell, proof and lock pages).
  darkMode: 'class',
  content: [
    './src/pages/**/*.{js,ts,jsx,tsx,mdx}',
    './src/components/**/*.{js,ts,jsx,tsx,mdx}',
    './src/app/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      colors: {
        primary: {
          50: '#f9eeec',
          100: '#f1d9d5',
          200: '#e5b7b0',
          300: '#d58d83',
          400: '#c45a4c',
          500: '#b64d40',
          600: '#a94438',
          700: '#8e382f',
          800: '#702e28',
          900: '#4b211e',
        },
        graphite: '#15171B',
        slate: '#89939F',
        gold: '#D6A84F',
      },
      fontFamily: {
        display: ['Fraunces', 'Georgia', 'Cambria', 'Times New Roman', 'serif'],
        sans: ['Inter', 'ui-sans-serif', 'system-ui', '-apple-system', 'Segoe UI', 'Roboto', 'sans-serif'],
      },
      keyframes: {
        'fade-up': {
          '0%': { opacity: '0', transform: 'translateY(10px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        shimmer: {
          '0%': { backgroundPosition: '-400px 0' },
          '100%': { backgroundPosition: '400px 0' },
        },
        'pulse-dot': {
          '0%, 100%': { opacity: '1', transform: 'scale(1)' },
          '50%': { opacity: '.45', transform: 'scale(.8)' },
        },
      },
      animation: {
        'fade-up': 'fade-up .5s cubic-bezier(.2,.7,.2,1) both',
        shimmer: 'shimmer 1.6s linear infinite',
        'pulse-dot': 'pulse-dot 2s ease-in-out infinite',
      },
    },
  },
  plugins: [],
}
export default config
