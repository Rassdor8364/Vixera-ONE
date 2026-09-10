import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      "packages/*",
      "packages/connectors/*",
      "apps/desktop",
    ],
    passWithNoTests: false,
  },
});
