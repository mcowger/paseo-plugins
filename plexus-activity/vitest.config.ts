import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * The Paseo SDK entry points are host-provided at runtime. Tests that import shared or server
 * modules still resolve those specifiers through module graph imports, so alias them to a stub.
 */
export default defineConfig({
  resolve: {
    alias: {
      "@getpaseo/plugin/server": fileURLToPath(
        new URL("./test/stubs/plugin-sdk.ts", import.meta.url),
      ),
      "@getpaseo/plugin/client/react-native": fileURLToPath(
        new URL("./test/stubs/plugin-sdk.ts", import.meta.url),
      ),
      "@getpaseo/plugin/client/ui": fileURLToPath(
        new URL("./test/stubs/plugin-sdk.ts", import.meta.url),
      ),
      "@getpaseo/plugin/client": fileURLToPath(
        new URL("./test/stubs/plugin-sdk.ts", import.meta.url),
      ),
      "@getpaseo/plugin": fileURLToPath(new URL("./test/stubs/plugin-sdk.ts", import.meta.url)),
    },
  },
  test: {
    include: ["**/*.test.ts"],
  },
});
