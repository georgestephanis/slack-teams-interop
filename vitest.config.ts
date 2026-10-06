import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Fail any test that opens a connection beyond loopback (see the file for why)
    setupFiles: ['./tests/setup/no-network.ts'],
  },
});
