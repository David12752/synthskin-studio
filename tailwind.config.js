/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './index.html',
    './src/**/*.{js,ts,jsx,tsx}',
  ],
  theme: {
    extend: {
      colors: {
        surface: {
          0: '#14110f',   // status bar, deepest
          1: '#1a1816',   // side panels
          2: '#1f1d1b',   // toolbars, command palette, context menus
          3: '#252220',   // hover states, elevated elements
          4: '#2a2724',   // borders, dividers
          5: '#3a3633',   // separators, subtle borders
        },
        canvas: {
          DEFAULT: '#161412', // canvas background
        },
        accent: {
          DEFAULT: '#ffaa33',
          dim: '#cc8829',
          bright: '#ffbb55',
          text: '#ffe8b3',   // active workspace text
          bg15: 'rgba(255,170,51,0.15)', // active tool bg
        },
        muted: {
          DEFAULT: '#6a6560',   // inactive text, section headers
          hover: '#8a8580',     // inactive hover
          text: '#c4c0b8',     // icon default color
        },
      },
      fontFamily: {
        display: ['"Inter Tight"', 'system-ui', 'sans-serif'],
        mono: ['"JetBrains Mono"', '"Cascadia Code"', 'Consolas', 'monospace'],
      },
    },
  },
  plugins: [],
}
