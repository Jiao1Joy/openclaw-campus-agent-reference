import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';
import { campusAssistantPlugin } from './server/campusAssistantPlugin';

// Vite dev server also exposes the local OpenClaw campus-assistant API.
export default defineConfig({
  plugins: [react(), campusAssistantPlugin()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    port: 5173,
    open: true,
  },
});
