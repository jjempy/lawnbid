import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
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
