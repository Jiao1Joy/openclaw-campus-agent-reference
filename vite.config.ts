import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';
import { campusAssistantPlugin } from './server/campusAssistantPlugin';
import { campusAdminPlugin } from './server/campusAdminPlugin';
import { campusAdminAgentWorkerPlugin } from './server/campusAdminAgent';

// Vite dev server also exposes the local OpenClaw campus-assistant API
// (student) and the campus-admin API.
export default defineConfig({
  plugins: [react(), campusAssistantPlugin(), campusAdminPlugin(), campusAdminAgentWorkerPlugin()],
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
