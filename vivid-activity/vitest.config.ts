import { defineConfig } from "vitest/config";
export default defineConfig({ test: { setupFiles: ["./tests/i18n-setup.ts"] } });
