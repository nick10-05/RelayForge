import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// In development the dashboard runs on Vite (:5173, instant reloads) and forwards API and
// ingest calls to Fastify (:3000). In production Fastify serves the built files itself, so the
// dashboard and API share one origin (first-party session cookie, no CORS).
const api = 'http://127.0.0.1:3000';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: { '/api': api, '/in': api, '/healthz': api, '/readyz': api },
  },
  build: { outDir: 'dist', emptyOutDir: true },
});
