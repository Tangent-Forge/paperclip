import { provisionE2eBoardCredential } from "./board-key-bootstrap.js";

/**
 * Runs once, after Playwright's webServer has started and is healthy
 * (Playwright awaits `webServer.url` before running globalSetup), before
 * any spec file executes. Provisions the e2e-only board credential a
 * handful of specs need (see fixtures/board-auth.ts) and does nothing else.
 */
export default async function globalSetup(): Promise<void> {
  await provisionE2eBoardCredential();
}
