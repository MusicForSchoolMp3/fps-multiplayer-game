import { defineConfig } from 'vite';

export default defineConfig({
  root: '.',
  server: {
    port: 3000,
    open: true,
  },
  build: {
    outDir: 'dist',
    // Enable content hashing for long-term caching
    sourcemap: false, // Disable sourcemaps in production to reduce bandwidth
    minify: 'esbuild', // Use esbuild (default, faster, no extra dependencies)
    rollupOptions: {
      output: {
        // Ensure consistent hashing for better caching
        entryFileNames: 'assets/[name].[hash].js',
        chunkFileNames: 'assets/[name].[hash].js',
        assetFileNames: 'assets/[name].[hash].[ext]',
      },
    },
  },
});
