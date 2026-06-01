import { describe, expect, it } from "vitest";
import type { Request } from "express";
import { shouldServeStaticSpaHtml, shouldServeViteDevHtml } from "../app.js";

function createRequest(path: string, acceptsResult: string | false): Request {
  return {
    path,
    accepts: () => acceptsResult,
  } as unknown as Request;
}

describe("shouldServeViteDevHtml", () => {
  it("serves HTML shell for document requests", () => {
    expect(shouldServeViteDevHtml(createRequest("/", "html"))).toBe(true);
    expect(shouldServeViteDevHtml(createRequest("/issues/abc", "html"))).toBe(true);
  });

  it("skips public assets even when the client accepts */*", () => {
    expect(shouldServeViteDevHtml(createRequest("/sw.js", "html"))).toBe(false);
    expect(shouldServeViteDevHtml(createRequest("/site.webmanifest", "html"))).toBe(false);
  });

  it("skips vite asset requests", () => {
    expect(shouldServeViteDevHtml(createRequest("/@vite/client", "html"))).toBe(false);
    expect(shouldServeViteDevHtml(createRequest("/src/main.tsx", "html"))).toBe(false);
    expect(shouldServeViteDevHtml(createRequest("/index-Ca4u1jjO.css", "html"))).toBe(false);
  });
});

describe("shouldServeStaticSpaHtml", () => {
  it("serves HTML shell for SPA routes", () => {
    expect(shouldServeStaticSpaHtml("/")).toBe(true);
    expect(shouldServeStaticSpaHtml("/issues/abc")).toBe(true);
  });

  it("does not serve the HTML shell for missing asset-like paths", () => {
    expect(shouldServeStaticSpaHtml("/assets/missing.css")).toBe(false);
    expect(shouldServeStaticSpaHtml("/ui/assets/index-Ca4u1jjO.css")).toBe(false);
    expect(shouldServeStaticSpaHtml("/index-Ca4u1jjO.css")).toBe(false);
    expect(shouldServeStaticSpaHtml("/index-Dhu3o6v0.js")).toBe(false);
    expect(shouldServeStaticSpaHtml("/sw.js")).toBe(false);
    expect(shouldServeStaticSpaHtml("/site.webmanifest")).toBe(false);
  });
});
