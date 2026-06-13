import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    target: 'esnext'
  },
  optimizeDeps: {
    esbuildOptions: {
      target: 'esnext'
    }
  },
  server: {
    host: '127.0.0.1',
    port: 5173
  }
});
