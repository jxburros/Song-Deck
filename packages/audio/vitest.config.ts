import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'audio',
    include: ['test/**/*.test.ts'],
    testTimeout: 60000,
  },
});
