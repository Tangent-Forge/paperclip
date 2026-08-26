import fs from "node:fs";
import { createRequire } from "node:module";
import type { AddressInfo, Server as NetServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { Server as TlsServer } from "node:tls";

type SupertestServer = NetServer & {
  address(): ReturnType<NetServer["address"]>;
  listen(port: number): NetServer;
};

type SupertestTestInstance = {
  _server?: SupertestServer;
};

type SupertestTestConstructor = {
  prototype: {
    serverAddress(this: SupertestTestInstance, app: SupertestServer, path: string): string;
    __paperclipLoopbackPatched?: boolean;
  };
};

const require = createRequire(import.meta.url);
const SupertestTest = require("supertest/lib/test.js") as SupertestTestConstructor;

// Server suites must never read the real ~/.paperclip of a machine that hosts
// a live instance: resolvePaperclipHomeDir() falls back to ~/.paperclip when
// PAPERCLIP_HOME is unset, so instance state (e.g. adapter-settings.json
// disabling adapters) leaks into tests and makes them fail locally while
// passing on CI. Pin PAPERCLIP_HOME to a fresh per-run temp dir
// unconditionally — an inherited value from a live instance's shell is the
// same contamination. Suites that need a specific home dir set and restore
// process.env.PAPERCLIP_HOME themselves, which runs after this setup file.
process.env.PAPERCLIP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-vitest-home-"));

if (!process.env.CODEX_HOME) {
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-vitest-codex-home-"));
  fs.writeFileSync(path.join(codexHome, "auth.json"), '{"OPENAI_API_KEY":"sk-vitest"}\n', { mode: 0o600 });
  process.env.CODEX_HOME = codexHome;
}

// The automatic Tailscale HTTPS default (PAP-17158) probes for a real host
// broker socket, so leaving it enabled would make every test that starts a
// service named `paperclip-dev` behave differently on a broker-capable host
// than on CI. Tests that exercise the default opt in explicitly.
if (!process.env.PAPERCLIP_MANAGED_RUNTIME_HTTPS) {
  process.env.PAPERCLIP_MANAGED_RUNTIME_HTTPS = "off";
}

if (!SupertestTest.prototype.__paperclipLoopbackPatched) {
  SupertestTest.prototype.serverAddress = function serverAddress(app, path) {
    const addr = app.address();

    if (!addr) {
      this._server = app.listen(0) as SupertestServer;
    }

    const listeningAddress = app.address() as AddressInfo | string | null;
    if (!listeningAddress || typeof listeningAddress === "string") {
      throw new Error("Expected Supertest server to listen on a TCP port");
    }

    const host = listeningAddress.address === "::"
      ? "[::1]"
      : listeningAddress.address === "0.0.0.0"
        ? "127.0.0.1"
        : listeningAddress.address;
    const protocol = app instanceof TlsServer ? "https" : "http";
    return `${protocol}://${host}:${listeningAddress.port}${path}`;
  };

  SupertestTest.prototype.__paperclipLoopbackPatched = true;
}
