import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { copyFileSync } from 'fs'

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    {
      name: 'copy-redirects',
      closeBundle() {
        copyFileSync('public/_redirects', 'dist/_redirects')
      },
    },
  ],
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules/@supabase/')) return 'supabase'
          if (id.includes('node_modules/jspdf')) return 'pdf'
          if (id.includes('node_modules/dompurify')) return 'dompurify'
          if (id.includes('node_modules/html2canvas')) return 'html2canvas'
        },
      },
    },
    chunkSizeWarningLimit: 600,
  },
})
