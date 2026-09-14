import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "server/**/*.test.ts",
      "shared/**/*.test.ts",
      "client/profile-policy-sync.test.ts",
      "client/pi-profile-indicator.test.ts",
    ],
  },
});
