import { resolve } from 'path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

/**
 * Build do app do tablet (Android via Capacitor): reaproveita o motor WebRTC, sons e avatares do
 * renderer do PC, com uma interface simplificada (chat + ligação).
 */
export default defineConfig({
  root: resolve(__dirname, 'src/mobile'),
  // O .env fica na raiz do projeto (mesmas chaves do Supabase/TURN e PINs do app de PC)
  envDir: __dirname,
  base: './',
  plugins: [react()],
  resolve: {
    alias: {
      '@renderer': resolve(__dirname, 'src/renderer/src')
    }
  },
  build: {
    outDir: resolve(__dirname, 'mobile-dist'),
    emptyOutDir: true,
    target: 'chrome100'
  },
  server: {
    port: 5180,
    host: true
  }
})
