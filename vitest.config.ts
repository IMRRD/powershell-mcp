import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { maxWorkers: 4, testTimeout: 20000 } });
