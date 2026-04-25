import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

export default defineConfig({
  resolve: {
    alias: [
      { find: '@apilix/core/types', replacement: resolve(__dirname, '../packages/core/types/index.ts') },
      { find: '@apilix/core/variable-resolver', replacement: resolve(__dirname, '../packages/core/src/variable-resolver.js') },
      { find: '@apilix/core', replacement: resolve(__dirname, '../packages/core/src/index.js') },
    ],
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.{ts,tsx}'],
  },
});
