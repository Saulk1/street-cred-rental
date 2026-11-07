import './server/env.mjs';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/server/**/*.test.ts'],
    restoreMocks: true,
    unstubEnvs: true,
  },
});
