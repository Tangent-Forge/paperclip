import { revokeE2eBoardCredential } from "./board-key-bootstrap.js";

/**
 * Runs once after all specs finish (including on failure/interruption, per
 * Playwright's globalTeardown contract). Deletes the e2e board credential
 * and its backing user row from the throwaway instance's database, and
 * removes the on-disk credential file.
 */
export default async function globalTeardown(): Promise<void> {
  await revokeE2eBoardCredential();
}
