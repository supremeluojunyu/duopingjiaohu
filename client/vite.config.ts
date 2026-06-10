import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import basicSsl from '@vitejs/plugin-basic-ssl';

const useHttps = process.env.VITE_HTTPS === 'true' || process.env.VITE_HTTPS === '1';

export default defineConfig({
  // Electron loadFile uses file:// — absolute /assets paths fail and show a blank window.
  base: './',
  plugins: [react(), ...(useHttps ? [basicSsl()] : [])],
  server: {
    port: 8080,
    host: true,
    https: useHttps ? {} : undefined,
    proxy: {
      '/api': {
        target: process.env.VITE_SIGNALING_PROXY ?? 'http://127.0.0.1:9876',
        changeOrigin: true,
      },
      '/downloads': {
        target: process.env.VITE_SIGNALING_PROXY ?? 'http://127.0.0.1:9876',
        changeOrigin: true,
      },
    },
  },
});
