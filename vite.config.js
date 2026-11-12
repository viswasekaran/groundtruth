// Vite builds the plain-JS pages in web/ into dist/, which Express serves.
// Dev: `npm run dev` runs the API on :3000 and Vite on :5173 (proxying API calls).
import { defineConfig } from 'vite';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, 'web');
const pages = ['index', 'agent', 'bounty', 'hunter', 'developers'];
const api = process.env.API_URL || 'http://localhost:3000';

export default defineConfig({
  root,
  build: {
    outDir: resolve(import.meta.dirname, 'dist'),
    emptyOutDir: true,
    rollupOptions: { input: Object.fromEntries(pages.map((p) => [p, resolve(root, `${p}.html`)])) },
  },
  server: {
    port: 5173,
    proxy: { '/api': api, '/uploads': api, '/mcp': api },
  },
});
