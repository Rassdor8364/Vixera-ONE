import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      "packages/domain",
      "packages/sync",
      "packages/command",
      "packages/intelligence",
      "packages/connectors/*",
      "apps/desktop",
    ],
  },
});
