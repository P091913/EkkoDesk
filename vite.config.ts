import { defineConfig } from 'vite';

export default defineConfig({
  root: 'web',
  server: { proxy: { '/ws': { target: 'ws://127.0.0.1:8081', ws: true } } },
});
