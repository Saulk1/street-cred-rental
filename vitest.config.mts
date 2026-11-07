import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
export default defineConfig({ plugins: [react()], resolve: { alias: { '@': fileURLToPath(new URL('./extension/src', import.meta.url)) } }, test: { environment: 'jsdom', include: ['tests/ui/**/*.test.tsx'], setupFiles: ['tests/ui/setup.ts'] } });
