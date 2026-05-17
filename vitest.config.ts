import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        environment: 'jsdom',
        include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
        coverage: {
            provider: 'v8',
            reporter: ['text', 'lcov', ['json-summary', { file: 'coverage-app.json' }]],
            reportsDirectory: 'coverage',
            include: ['src/lib/**/*.ts'],
            exclude: ['src/lib/driveApi.ts'],
        },
    },
});
