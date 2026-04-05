import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { copyFileSync, existsSync } from 'fs'

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    {
      name: 'copy-files',
      closeBundle() {
        if (existsSync('public/_redirects')) {
          copyFileSync('public/_redirects', 'dist/_redirects')
          console.log('✓ _redirects copied')
        }
        if (existsSync('public/landing.html')) {
          copyFileSync('public/landing.html', 'dist/landing.html')
          console.log('✓ landing.html copied')
        }
        if (existsSync('public/_worker.js')) {
          copyFileSync('public/_worker.js', 'dist/_worker.js')
          console.log('✓ _worker.js copied')
        }
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
