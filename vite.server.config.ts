import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    ssr: 'server/standalone.ts',
    outDir: 'dist-server',
    emptyOutDir: true,
    copyPublicDir: false,
    rollupOptions: {
      output: {
        entryFileNames: 'standalone.js',
      },
    },
  },
});
