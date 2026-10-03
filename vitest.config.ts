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
  },
});
