import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        environment: 'jsdom',
        include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
        coverage: {
            provider: 'v8',
            reporter: ['text', ['text', { file: 'coverage-app.txt' }], 'lcov'],
            reportsDirectory: 'coverage',
            include: ['src/lib/**/*.ts'],
            exclude: ['src/lib/driveApi.ts', 'src/lib/localCache.ts'],
        },
    },
});
