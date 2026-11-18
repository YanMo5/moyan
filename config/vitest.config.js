import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
    // 配置文件本身放在 config/，测试根目录仍指向仓库根，include 才能匹配 tests/
    root: fileURLToPath(new URL('..', import.meta.url)),
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
