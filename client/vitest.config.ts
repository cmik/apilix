import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

export default defineConfig({
  resolve: {
    alias: {
      '@apilix/core/types': resolve(__dirname, '../packages/core/types/index.ts'),
      '@apilix/core': resolve(__dirname, '../packages/core/src/index.js'),
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.{ts,tsx}'],
  },
});
