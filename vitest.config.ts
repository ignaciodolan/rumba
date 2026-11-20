import { configDefaults, defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // The end-to-end tests need Docker and run with `npm run test:e2e` (vitest.e2e.config.ts).
    exclude: [...configDefaults.exclude, 'tests/e2e/**'],
  },
})
