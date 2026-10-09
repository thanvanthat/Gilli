import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The C# backend. In development the Vite server proxies /hubs and /api to it, so the browser
// talks to a single origin (no CORS) and WebSockets are forwarded too.
const backend = process.env.GILLI_SERVER_URL ?? 'http://localhost:5080';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true, // fail loudly on a port conflict instead of silently moving to another port
    proxy: {
      '/hubs': { target: backend, ws: true, changeOrigin: true },
      '/api': { target: backend, changeOrigin: true },
      '/health': { target: backend, changeOrigin: true },
    },
  },
  build: {
    outDir: 'dist',
    chunkSizeWarningLimit: 1200,
  },
});
