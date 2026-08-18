import { test as base, expect } from "@playwright/test";
import { readE2eBoardCredential } from "../board-key-bootstrap.js";

/**
 * Drop-in replacement for `@playwright/test`'s `test` for specs whose setup
 * needs board authority (creating a company, toggling an instance-level
 * experimental flag) that PAP-1975 correctly no longer grants for free to
 * unauthenticated loopback requests.
 *
 * Attaches the e2e-only board API key (see board-key-bootstrap.ts,
 * provisioned once in global-setup.ts) as a bearer token on every request
 * from the test's browser context — the same `Authorization: Bearer <token>`
 * path any real board API key uses (server/src/middleware/auth.ts), not a
 * special case for tests.
 *
 * Specs that don't call board-protected endpoints should keep importing
 * `test`/`expect` from "@playwright/test" directly — this fixture exists
 * for the specific consumers migrated off the old implicit local-board
 * grant, not as a blanket replacement.
 */
export const test = base.extend({
  context: async ({ context }, use) => {
    const credential = readE2eBoardCredential();
    if (!credential) {
      throw new Error(
        "fixtures/board-auth: no e2e board credential found. " +
          "This fixture requires global-setup.ts to have run first " +
          "(it should have, via playwright.config.ts's globalSetup) — " +
          "if you're running this spec file in isolation outside the " +
          "configured test runner, that's why.",
      );
    }
    await context.setExtraHTTPHeaders({ Authorization: `Bearer ${credential.token}` });
    await use(context);
  },
});

export { expect };
