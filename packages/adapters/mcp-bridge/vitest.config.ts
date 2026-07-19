import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.{ts,js,mts,cts}"],
    exclude: ["dist/**", "node_modules/**"],
    environment: "node",
  },
});
