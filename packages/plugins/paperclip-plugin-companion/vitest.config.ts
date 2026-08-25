import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Service-layer tests (tests/**/*.spec.ts) run under the default "node"
    // environment set below. UI component tests (tests/**/*.spec.tsx) opt
    // into jsdom individually via a `// @vitest-environment jsdom` pragma at
    // the top of the file, so adding UI tests never changes how the
    // existing service tests run.
    include: ["tests/**/*.spec.ts", "tests/**/*.spec.tsx"],
    environment: "node",
    setupFiles: ["./tests/setup-jest-dom.ts"],
  },
});
