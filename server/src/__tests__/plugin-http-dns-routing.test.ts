import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";

const dnsLookupMock = vi.hoisted(() => vi.fn());
const httpsRequestMock = vi.hoisted(() => vi.fn());

vi.mock("node:dns/promises", () => ({
  lookup: dnsLookupMock,
}));

vi.mock("node:https", () => ({
  request: httpsRequestMock,
}));

describe("plugin HTTP DNS routing", () => {
  it("prefers a public IPv4 address when DNS returns IPv6 first", async () => {
    dnsLookupMock.mockResolvedValueOnce([
      { address: "2606:4700::6810:85e5", family: 6 },
      { address: "104.18.133.229", family: 4 },
    ]);
    const { validateAndResolveFetchUrl } = await import("../services/plugin-host-services.js");

    const target = await validateAndResolveFetchUrl("https://api.linear.app/graphql");

    expect(target.resolvedAddress).toBe("104.18.133.229");
    expect(target.hostHeader).toBe("api.linear.app");
    expect(target.tlsServername).toBe("api.linear.app");
  });

  it("still rejects hosts with only private or reserved addresses", async () => {
    dnsLookupMock.mockResolvedValueOnce([
      { address: "127.0.0.1", family: 4 },
      { address: "10.0.0.5", family: 4 },
      { address: "fd00::1", family: 6 },
    ]);
    const { validateAndResolveFetchUrl } = await import("../services/plugin-host-services.js");

    await expect(validateAndResolveFetchUrl("https://private.example.test/")).rejects.toThrow(
      "No routable public IPs resolved for private.example.test: all resolved IPs are in private/reserved ranges",
    );
  });

  it("classifies DNS lookup timeouts", async () => {
    vi.useFakeTimers();
    dnsLookupMock.mockImplementationOnce(() => new Promise(() => undefined));
    const { validateAndResolveFetchUrl } = await import("../services/plugin-host-services.js");

    const promise = expect(validateAndResolveFetchUrl("https://timeout.example.test/")).rejects.toThrow(
      "DNS lookup timed out after 5000ms for timeout.example.test",
    );
    await vi.advanceTimersByTimeAsync(5_000);
    await promise;
    vi.useRealTimers();
  });

  it("classifies pinned IPv6 EHOSTUNREACH when no IPv4 fallback exists", async () => {
    dnsLookupMock.mockResolvedValueOnce([{ address: "2606:4700::6810:85e5", family: 6 }]);
    httpsRequestMock.mockImplementationOnce(() => {
      const req = new EventEmitter() as EventEmitter & { write: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> };
      req.write = vi.fn();
      req.end = vi.fn(() => {
        const err = new Error("connect EHOSTUNREACH 2606:4700::6810:85e5:443") as Error & { code: string };
        err.code = "EHOSTUNREACH";
        req.emit("error", err);
      });
      return req;
    });
    const { buildHostServices } = await import("../services/plugin-host-services.js");
    const services = buildHostServices({} as never, "plugin-id", "plugin-key", {
      forPlugin: () => ({ emit: vi.fn(), subscribe: vi.fn(), clear: vi.fn() }),
    } as never);

    await expect(services.http.fetch({ url: "https://ipv6-only.example.test/graphql" })).rejects.toThrow(
      "Plugin HTTP request failed via IPv6 (EHOSTUNREACH) for ipv6-only.example.test; no public IPv4 DNS answer was available for fallback",
    );
    services.dispose();
  });
});
