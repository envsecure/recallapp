import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Dev proxy: the local backend listens on 127.0.0.1:5174 (loopback only, C1).
// The React app only ever talks to same-origin /api — no external network.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    allowedHosts: ['.cloudspaces.litng.ai'],
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:5174',
        changeOrigin: true,
      },
    },
  },
  preview: {
    port: 5173,
  },
});
