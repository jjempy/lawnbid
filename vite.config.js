import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { copyFileSync, existsSync, mkdirSync, renameSync } from 'fs'

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    {
      name: 'copy-files',
      closeBundle() {
        // Move Vite's React-app output from dist/index.html → dist/app/index.html
        // so Cloudflare Pages serves it naturally at URL /app/ (and /app via canonical redirect).
        if (existsSync('dist/index.html')) {
          mkdirSync('dist/app', { recursive: true })
          renameSync('dist/index.html', 'dist/app/index.html')
          console.log('✓ dist/index.html → dist/app/index.html (React app)')
        }
        // Put the landing page at dist/index.html so / serves landing.
        if (existsSync('public/landing.html')) {
          copyFileSync('public/landing.html', 'dist/index.html')
          console.log('✓ landing.html → dist/index.html (root)')
          copyFileSync('public/landing.html', 'dist/landing.html')
          console.log('✓ landing.html copied (backup)')
        }
        if (existsSync('public/_redirects')) {
          copyFileSync('public/_redirects', 'dist/_redirects')
          console.log('✓ _redirects copied')
        }
        if (existsSync('public/_headers')) {
          copyFileSync('public/_headers', 'dist/_headers')
          console.log('✓ _headers copied')
        }
        if (existsSync('public/lawnbid-translations.xlsx')) {
          copyFileSync('public/lawnbid-translations.xlsx', 'dist/lawnbid-translations.xlsx')
          console.log('✓ translations.xlsx copied')
        }
      },
    },
  ],
  server: {
    headers: { 'Cache-Control': 'no-store' },
  },
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
