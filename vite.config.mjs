import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The dev server injects an inline React Refresh preamble, so the CSP needs
// 'unsafe-inline' for scripts only while serving; production builds keep it strict.
const devCsp = {
  name: 'dev-csp',
  apply: 'serve',
  transformIndexHtml: (html) => html.replace("script-src 'self'", "script-src 'self' 'unsafe-inline'"),
};

export default defineConfig({
  root: 'renderer',
  base: './',
  plugins: [react(), devCsp],
  server: { port: 5199, strictPort: true, host: '127.0.0.1' },
  build: {
    outDir: '../dist',
    emptyOutDir: true,
    chunkSizeWarningLimit: 4000,
  },
});
