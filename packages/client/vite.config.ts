import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const pkg = JSON.parse(readFileSync(resolve(__dirname, '../../package.json'), 'utf-8'));

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  resolve: {
    alias: {
      '@apilix/core/types': resolve(__dirname, '../core/types/index.ts'),
    },
  },
  plugins: [react()],
  base: './',
  build: {
    chunkSizeWarningLimit: 700,
    commonjsOptions: {
      include: [/packages\/core/, /node_modules/],
    },
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules/react') || id.includes('node_modules/react-dom')) {
            return 'vendor-react';
          }

          if (id.includes('node_modules/prismjs')) {
            return 'vendor-prism';
          }

          if (id.includes('node_modules/ajv')) {
            return 'vendor-ajv';
          }

          if (id.includes('node_modules/axios') || id.includes('node_modules/js-yaml') || id.includes('node_modules/marked')) {
            return 'vendor-libs';
          }

          if (id.includes('/src/components/CodeEditor') || id.includes('/src/components/ScriptEditor')) {
            return 'editor-core';
          }

          if (id.includes('/src/components/GraphQLPanel') || id.includes('/src/components/MongoPanel') || id.includes('/src/components/MongoRequestPanel')) {
            return 'editor-panels';
          }

          if (id.includes('/src/utils/postmanValidator') || id.includes('/src/schemas/postman-v2.0.json') || id.includes('/src/schemas/postman-v2.1.json')) {
            return 'postman-validation';
          }
        },
      },
    },
  },
  optimizeDeps: {
    include: ['@apilix/core/variable-resolver'],
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
    },
  },
});
