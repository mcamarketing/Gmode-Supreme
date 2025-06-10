/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        godmode: '#ffd700',
        godpurple: '#a020f0',
        godbg: '#0a0a23'
      },
      fontFamily: {
        god: ['Orbitron', 'Montserrat', 'sans-serif']
      },
      animation: {
        'shimmer': 'shimmer 2s ease-in-out infinite',
        'godmode-breath': 'godmode-breath 3s ease-in-out infinite',
        'mca-shimmer': 'mca-shimmer 2.5s infinite',
        'float': 'float 6s ease-in-out infinite',
        'pulse-glow': 'pulse-glow 2s ease-in-out infinite alternate',
      },
      keyframes: {
        shimmer: {
          '0%': { transform: 'translateX(-100%) skewX(-12deg)' },
          '100%': { transform: 'translateX(200%) skewX(-12deg)' }
        },
        'godmode-breath': {
          '0%, 100%': {
            textShadow: '0 0 20px #ffd700, 0 0 40px #a020f0, 0 0 60px #fff',
            color: '#ffd700'
          },
          '50%': {
            textShadow: '0 0 40px #fff, 0 0 80px #a020f0, 0 0 100px #ffd700',
            color: '#fff8dc'
          }
        },
        'mca-shimmer': {
          '0%': { left: '-100%' },
          '100%': { left: '100%' }
        },
        float: {
          '0%, 100%': { transform: 'translateY(0px)' },
          '50%': { transform: 'translateY(-20px)' }
        },
        'pulse-glow': {
          '0%': { 
            boxShadow: '0 0 20px #ffd700, 0 0 40px #a020f0',
            transform: 'scale(1)'
          },
          '100%': { 
            boxShadow: '0 0 40px #ffd700, 0 0 80px #a020f0',
            transform: 'scale(1.05)'
          }
        }
      },
      backgroundImage: {
        'godmode-gradient': 'linear-gradient(135deg, #0a0a23 0%, #1a1a3a 50%, #2a1a4a 100%)',
        'profit-gradient': 'linear-gradient(135deg, #10b981 0%, #059669 100%)',
        'flashloan-gradient': 'linear-gradient(135deg, #3b82f6 0%, #1d4ed8 100%)',
        'mev-gradient': 'linear-gradient(135deg, #8b5cf6 0%, #7c3aed 100%)',
        'arbitrage-gradient': 'linear-gradient(135deg, #f59e0b 0%, #d97706 100%)',
      },
      blur: {
        'xs': '2px',
        '4xl': '72px',
        '5xl': '96px',
      },
      dropShadow: {
        'glow': [
          '0 0 20px rgba(255, 215, 0, 0.35)',
          '0 0 65px rgba(160, 32, 240, 0.2)'
        ],
        'profit': '0 0 25px rgba(16, 185, 129, 0.5)',
        'flashloan': '0 0 25px rgba(59, 130, 246, 0.5)',
      },
      backdropBlur: {
        'xs': '2px',
      },
      spacing: {
        '18': '4.5rem',
        '88': '22rem',
        '128': '32rem',
      }
    },
  },
  plugins: [],
};