import { useState } from "react";
import { Overview } from "./tabs/Overview.js";
import { Sources } from "./tabs/Sources.js";
import { Search } from "./tabs/Search.js";
import { Audit } from "./tabs/Audit.js";

type TabKey = "overview" | "sources" | "search" | "audit";

const TABS: Array<{ key: TabKey; label: string }> = [
  { key: "overview", label: "Overview" },
  { key: "sources", label: "Sources" },
  { key: "search", label: "Search" },
  { key: "audit", label: "Audit" },
];

// v0 scaffold: lightweight in-component tab switcher. A later phase will swap
// this for Paperclip's shared Tabs component once we wire the page through the
// plugin UI bridge (paperclip-plugin-sdk/ui types like PluginPageProps).
export function BrainPage() {
  const [tab, setTab] = useState<TabKey>("overview");

  return (
    <div className="p-6">
      <h1 className="text-2xl font-semibold mb-4">Brain</h1>
      <div className="flex gap-2 border-b mb-4">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setTab(t.key)}
            className={
              tab === t.key
                ? "px-3 py-2 text-sm font-medium border-b-2 border-foreground"
                : "px-3 py-2 text-sm text-muted-foreground"
            }
          >
            {t.label}
          </button>
        ))}
      </div>
      {tab === "overview" && <Overview />}
      {tab === "sources" && <Sources />}
      {tab === "search" && <Search />}
      {tab === "audit" && <Audit />}
    </div>
  );
}
