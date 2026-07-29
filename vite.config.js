import { defineConfig } from 'vite';

export default defineConfig({
  root: '.',
  publicDir: '.', // Serve files from root as public assets
  server: {
    port: 3000,
    open: true,
  },
  build: {
    outDir: 'dist',
    assetsInclude: ['*.fbx'], // Include FBX files as assets
  },
});
