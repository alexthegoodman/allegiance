import { defineConfig } from "vitest/config";

export default defineConfig({
    server: { port: 5190, strictPort: true },
    preview: { port: 5190, strictPort: true },
    worker: { format: "es" },
    build: { target: "es2022", sourcemap: true, chunkSizeWarningLimit: 4000 },
    test: { include: ["tests/unit/**/*.test.ts"], testTimeout: 120000, pool: "threads" },
});
