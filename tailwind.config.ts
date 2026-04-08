import type { Config } from 'tailwindcss';

const config: Config = {
  content: [
    './src/components/**/*.{js,ts,jsx,tsx,mdx}',
    './src/app/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      colors: {
        claw: {
          bg: '#111111',
          surface: '#171717',
          elevated: '#1D1D1D',
          input: '#252525',
          border: '#272727',
          'border-hover': '#3A3A3A',
          text: '#D4D4D4',
          'text-secondary': '#8C8C8C',
          'text-muted': '#5C5C5C',
          accent: '#D04040',
          'accent-hover': '#DA5555',
          link: '#7AA2D4',
          'link-hover': '#9AB8E2',
          success: '#3FB87F',
          warning: '#D4A036',
          error: '#D46363',
          info: '#7AA2D4',
        },
      },
      fontFamily: {
        display: ['JetBrains Mono', 'monospace'],
        body: ['JetBrains Mono', 'monospace'],
        mono: ['JetBrains Mono', 'monospace'],
      },
      borderRadius: {
        DEFAULT: '3px',
        lg: '3px',
        md: '3px',
        sm: '2px',
        full: '9999px',
      },
      animation: {
        'fade-in': 'fadeIn 0.3s ease-in-out',
        'slide-up': 'fadeSlideUp 0.3s ease-out both',
        'pulse-status': 'pulse-status 2s ease-in-out infinite',
      },
    },
  },
  darkMode: 'class',
  plugins: [],
};
export default config;
