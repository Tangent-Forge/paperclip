/**
 * Shared shutdown wiring for the MCP fixture servers.
 *
 * Fixtures are spawned as children of a harness, a test, or the Paperclip
 * server. None of those parents can be relied on to reap them: the Smoke Lab
 * sidecar is spawned `detached` and `unref`'d, and any parent can be SIGKILLed,
 * which delivers no signal to its children. A fixture that only exits when
 * asked therefore survives its parent and leaks for the lifetime of the box.
 *
 * Every fixture opts into two independent guarantees:
 *   1. Signals (SIGTERM/SIGINT/SIGHUP) shut it down gracefully.
 *   2. A watchdog notices the parent going away and exits regardless.
 */

const PARENT_POLL_MS = Number(process.env.MCP_FIXTURE_PARENT_POLL_MS ?? 1_000);
const SHUTDOWN_GRACE_MS = Number(process.env.MCP_FIXTURE_SHUTDOWN_GRACE_MS ?? 2_000);

export function installLifecycle({ onShutdown } = {}) {
  let shuttingDown = false;

  function shutdown(reason) {
    if (shuttingDown) return;
    shuttingDown = true;

    let exited = false;
    const exit = () => {
      if (exited) return;
      exited = true;
      process.exit(0);
    };

    // A hung connection or a stuck close callback must not strand the process:
    // the whole point of this module is that the fixture always goes away.
    setTimeout(exit, SHUTDOWN_GRACE_MS).unref();

    try {
      const result = onShutdown?.(reason);
      if (result && typeof result.then === "function") result.then(exit, exit);
      else exit();
    } catch {
      exit();
    }
  }

  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) {
    process.on(signal, () => shutdown(`signal:${signal}`));
  }

  // Compare against the ppid observed at startup rather than testing for pid 1.
  // Reparenting is the signal we care about, and the new parent may be a
  // subreaper rather than init.
  const initialPpid = process.ppid;
  setInterval(() => {
    if (process.ppid !== initialPpid) shutdown("parent-exited");
  }, PARENT_POLL_MS).unref();

  return shutdown;
}
