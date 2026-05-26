import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { runChildProcess } from "./server-utils.js";

describe("TAN-198 reproduction", () => {
  it("fails to detect terminal result if the JSON line is longer than the scan overlap", async () => {
    // We'll use a very small overlap to make the test fast and certain.
    // In server-utils.ts it is 64KB. We can't easily change it without editing the code,
    // so we'll generate a >64KB line.

    const largeSummary = "A".repeat(100 * 1024); // 100KB of 'A's
    const terminalResult = JSON.stringify({ type: "result", result: largeSummary });

    const result = await runChildProcess(
      randomUUID(),
      process.execPath,
      [
        "-e",
        [
          "process.stdout.write('noise\\n');",
          "const terminal = " + JSON.stringify(terminalResult) + ";",
          "process.stdout.write(terminal + '\\n');",
          "setTimeout(() => process.exit(0), 500);",
        ].join(" "),
      ],
      {
        cwd: process.cwd(),
        env: {},
        timeoutSec: 2,
        graceSec: 1,
        onLog: async () => {},
        terminalResultCleanup: {
          graceMs: 100,
          hasTerminalResult: ({ stdout }) => {
            // This mirrors how the claude adapter works: it tries to parse JSON lines.
            // If the line is partial, JSON.parse fails.
            for (const line of stdout.split(/\r?\n/)) {
               try {
                 const parsed = JSON.parse(line);
                 if (parsed.type === 'result') return true;
               } catch (e) {}
            }
            return false;
          },
        },
      },
    );

    // If it worked, the signal should be SIGTERM (from terminalResultCleanup).
    // If it failed to detect, it should have exited normally with code 0 (after 100ms).
    expect(result.signal).toBe("SIGTERM");
  });
});
