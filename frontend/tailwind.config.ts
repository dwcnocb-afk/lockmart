import type { Config } from 'tailwindcss'

const config: Config = {
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
    },
  },
  plugins: [],
}
export default config
