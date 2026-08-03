import { defineConfig } from 'vite';

// Source lives in src/; the production build is committed to docs/,
// which GitHub Pages serves at https://lp177.github.io/PortalBreakout/.
export default defineConfig({
  root: 'src',
  publicDir: 'public', // src/public → copied verbatim (peerjs vendor, .nojekyll)
  base: './',
  build: {
    outDir: '../docs',
    emptyOutDir: true,
    sourcemap: true,
    target: 'es2022',
  },
});
