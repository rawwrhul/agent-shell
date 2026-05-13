import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    env: {
      ANTHROPIC_API_KEY:   'test-key',
      GCP_PROJECT_ID:      'test-project',
      DATABASE_URL:        'postgresql://localhost/test',
      REDIS_HOST:          'localhost',
      LANGFUSE_PUBLIC_KEY: 'test-pk',
      LANGFUSE_SECRET_KEY: 'test-sk',
      NODE_ENV:            'development',
    },
  },
})
