// Arcade (v1) library build: playcanvas and @vibegames/sdk are served by the platform import map and stay external.
import { defineConfig } from 'vite';
export default defineConfig({ base: './', build: { target: 'es2022', outDir: 'dist', emptyOutDir: true, copyPublicDir: false, minify: 'oxc', sourcemap: false, lib: { entry: 'src/game.ts', formats: ['es'], fileName: () => 'game.js' }, rollupOptions: { external: ['playcanvas', '@vibegames/sdk'] } } });
