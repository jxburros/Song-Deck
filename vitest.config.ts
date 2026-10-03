import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      'packages/core',
      'packages/audio',
      'packages/ai',
      'apps/server',
      'apps/studio',
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'html', 'lcov'],
      include: ['packages/*/src/**', 'apps/server/src/**', 'apps/studio/src/**'],
    },
  },
});
