import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  worker: { format: 'es' },
  // relate-wasm loads its own .wasm via a URL import; keep it out of dependency pre-bundling.
  optimizeDeps: { exclude: ['@relate/relate-wasm'] },
});
