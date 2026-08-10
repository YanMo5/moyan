import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        pool: 'forks',
        testTimeout: 30000,
        hookTimeout: 25000,
        include: ['tests/**/*.test.js'],
        environment: 'node',
        sequence: {
            concurrent: false
        },
        reporter: ['verbose']
    }
});
