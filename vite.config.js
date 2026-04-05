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
        // Step 1: Preserve Vite's built index.html as dist/app.html (the React entry)
        if (existsSync('dist/index.html')) {
          copyFileSync('dist/index.html', 'dist/app.html')
          console.log('✓ dist/index.html → dist/app.html (React app)')
        }
        // Step 2: Overwrite dist/index.html with the landing page so / serves landing
        if (existsSync('public/landing.html')) {
          copyFileSync('public/landing.html', 'dist/landing.html')
          console.log('✓ landing.html copied')
          copyFileSync('public/landing.html', 'dist/index.html')
          console.log('✓ landing.html → dist/index.html (root)')
        }
        if (existsSync('public/_redirects')) {
          copyFileSync('public/_redirects', 'dist/_redirects')
          console.log('✓ _redirects copied')
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
