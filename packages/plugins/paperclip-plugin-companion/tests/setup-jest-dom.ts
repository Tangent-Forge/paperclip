// Extends vitest's `expect` with jest-dom matchers (toBeInTheDocument, etc.)
// for UI component tests. Harmless for service-layer (.spec.ts) tests, which
// never call these matchers.
import "@testing-library/jest-dom/vitest";
