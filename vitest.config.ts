import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'jsdom',
    globals: false,
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
    // Exclude legacy standalone scripts (use process.exit / not vitest-shaped).
    exclude: ['src/generator/__tests__/generator.test.ts', 'node_modules/**'],
  },
})
