import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';

// The app version comes from package.json at build time, so /bump only has to
// touch package.json, README.md and CHANGELOG.md.
const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));

export default defineConfig({
  base: './',
  define: { __APP_VERSION__: JSON.stringify(version) },
  worker: { format: 'es' },
  // relate-wasm loads its own .wasm via a URL import; keep it out of dependency pre-bundling.
  optimizeDeps: { exclude: ['@relate/relate-wasm'] },
});
