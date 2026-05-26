import fs from "node:fs";
import path from "node:path";

type ViteWatcherEvent = "add" | "change" | "unlink";

export interface ViteWatcherHost {
  watcher?: {
    on?: (event: ViteWatcherEvent, listener: (file: string) => void) => unknown;
    off?: (event: ViteWatcherEvent, listener: (file: string) => void) => unknown;
  };
  transformIndexHtml(url: string, html: string): Promise<string>;
}

export interface CachedViteHtmlRenderer {
  render(url: string): Promise<string>;
  dispose(): void;
}

const WATCHER_EVENTS: ViteWatcherEvent[] = ["add", "change", "unlink"];

export function createCachedViteHtmlRenderer(opts: {
  vite: ViteWatcherHost;
  uiRoot: string;
  brandHtml?: (html: string) => string;
}): CachedViteHtmlRenderer {
  const uiRoot = path.resolve(opts.uiRoot);
  const templatePath = path.resolve(uiRoot, "index.html");
  const brandHtml = opts.brandHtml ?? ((html: string) => html);
  let cachedHtml: string | null = null;

  function loadHtml(): string {
    if (cachedHtml === null) {
      const rawTemplate = fs.readFileSync(templatePath, "utf-8");
      cachedHtml = brandHtml(rawTemplate);
    }
    return cachedHtml;
  }

  function invalidate(): void {
    cachedHtml = null;
  }

  function onWatchEvent(filePath: string): void {
    const resolvedPath = path.resolve(filePath);
    if (resolvedPath === templatePath) {
      invalidate();
    }
  }

  for (const eventName of WATCHER_EVENTS) {
    opts.vite.watcher?.on?.(eventName, onWatchEvent);
  }

  return {
    async render(url: string): Promise<string> {
      const html = loadHtml();
      return await opts.vite.transformIndexHtml(url, html);
    },

    dispose(): void {
      for (const eventName of WATCHER_EVENTS) {
        opts.vite.watcher?.off?.(eventName, onWatchEvent);
      }
    },
  };
}
