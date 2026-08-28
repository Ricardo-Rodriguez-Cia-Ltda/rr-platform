import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    conditions: ['development'],
  },
  test: {
    include: [
      'tests/**/*.test.ts',
      'apps/**/tests/**/*.test.ts',
      'packages/**/tests/**/*.test.ts',
    ],
  },
});
