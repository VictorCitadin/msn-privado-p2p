/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./src/renderer/index.html', './src/renderer/src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        msn: ['Tahoma', 'Verdana', 'Segoe UI', 'sans-serif'],
        wmp: ['Consolas', 'Courier New', 'monospace']
      },
      colors: {
        msn: {
          sky: '#d9ecff',
          header: '#2e6da4',
          headerLight: '#5ca0d3',
          aero: '#e8f3fd',
          border: '#7da2ce',
          green: '#52b700',
          busy: '#d93025',
          offline: '#8e99a4'
        },
        wmp: {
          bg: '#0d1117',
          visor: '#050805',
          lime: '#76ff03',
          chrome: '#2b3240'
        }
      }
    }
  },
  plugins: []
}
