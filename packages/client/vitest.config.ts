import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

export default defineConfig({
  resolve: {
    alias: [
      { find: '@apilix/core/types', replacement: resolve(__dirname, '../core/types/index.ts') },
      { find: '@apilix/core/variable-resolver', replacement: resolve(__dirname, '../core/src/variable-resolver.js') },
      { find: '@apilix/core', replacement: resolve(__dirname, '../core/src/index.js') },
    ],
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.{ts,tsx}'],
    coverage: {
      provider: 'v8',
      thresholds: {
        statements: 44,
        branches: 39,
        functions: 43,
        lines: 46,
      },
    },
  },
});
