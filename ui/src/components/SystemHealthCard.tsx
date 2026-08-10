import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, ChevronDown, ChevronRight, HeartPulse, XCircle } from "lucide-react";
import { useState } from "react";
import { systemHealthApi, type HubHealth, type HubHealthCheck } from "../api/systemHealth";
import { timeAgo } from "../lib/timeAgo";
import { cn } from "@/lib/utils";

// The monitor runs every 5 minutes. Past this, treat the snapshot as untrustworthy and
// say so — a monitor that dies silently while the UI still renders "all clear" is the
// exact failure this card exists to prevent.
const STALE_AFTER_MS = 12 * 60 * 1000;

/**
 * Plain-English names for check ids. A person should never need to know what
 * "svc:hermes-edge" means to tell whether their system is working. Unmapped ids fall
 * back to the raw name so a new check still renders rather than disappearing.
 */
const CHECK_LABELS: Record<string, string> = {
  "route:paperclip": "Paperclip task board",
  "route:hermes": "Hermes",
  "route:api": "API endpoint",
  "origin:paperclip": "Paperclip app itself",
  "proxy:paperclip": "Paperclip local access",
  "svc:cloudflared": "Internet tunnel",
  "svc:paperclip": "Paperclip service",
  "svc:paperclip-mcp": "Paperclip agent bridge",
  "svc:gbrain": "TF Brain",
  "svc:hermes-gateway": "Hermes gateway",
  "svc:hermes-dashboard": "Hermes dashboard",
  "svc:hermes-edge": "Hermes edge",
  "svc:tf-dashboard-api": "Dashboard data service",
  "svc:tf-artifacts-static": "File server",
  "container:tf-postgres": "Paperclip database",
  "container:gbrain-postgres": "Brain database",
  "container:open-webui": "Open WebUI",
  "local:openwebui": "Open WebUI (local)",
};

function labelFor(check: HubHealthCheck) {
  return CHECK_LABELS[check.name] ?? check.name;
}

function CheckRow({ check }: { check: HubHealthCheck }) {
  const failed = check.status === "FAIL";
  return (
    <div className="flex items-center gap-2.5 py-1.5">
      <span
        className={cn("h-2 w-2 rounded-full shrink-0", failed ? "bg-red-500" : "bg-green-500")}
        aria-hidden
      />
      <span className="text-sm flex-1 min-w-0 truncate">{labelFor(check)}</span>
      {failed && (
        <span className="text-xs text-muted-foreground shrink-0">
          {check.failing_minutes > 0 ? `${check.failing_minutes}m` : "just now"}
        </span>
      )}
    </div>
  );
}

function CardShell({ children }: { children: React.ReactNode }) {
  return <div className="rounded-xl border bg-card p-4 shadow-sm">{children}</div>;
}

/**
 * Presentational half — takes a snapshot and renders it. Split out from the fetching
 * wrapper so every state (healthy / broken / stale) can be demonstrated on /design-guide
 * without a live server.
 */
export function SystemHealthCardView({ data }: { data: HubHealth }) {
  const [expanded, setExpanded] = useState(false);

  const stale = Date.now() - new Date(data.checked_at).getTime() > STALE_AFTER_MS;
  const failing = data.checks.filter((c) => c.status === "FAIL");
  // Failures first — never make someone hunt for the thing that is broken.
  const ordered = [...failing, ...data.checks.filter((c) => c.status === "OK")];

  let Icon = CheckCircle2;
  let iconClass = "text-green-500";
  let headline = "Everything is working";
  let detail = `All ${data.passing} checks passed`;

  if (stale) {
    Icon = AlertTriangle;
    iconClass = "text-yellow-500";
    headline = "Status is stale";
    detail = "The monitor has stopped reporting — don't trust the list below";
  } else if (data.failing > 0) {
    Icon = XCircle;
    iconClass = "text-red-500";
    headline = `${data.failing} ${data.failing === 1 ? "thing is" : "things are"} broken`;
    detail = `${data.passing} other checks passed`;
  }

  return (
    <CardShell>
      <div className="flex items-start gap-3">
        <Icon className={cn("h-5 w-5 shrink-0 mt-0.5", iconClass)} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <p className="text-sm font-semibold">{headline}</p>
            <HeartPulse className="h-3.5 w-3.5 text-muted-foreground/50" aria-hidden />
          </div>
          <p className="text-xs text-muted-foreground mt-0.5">
            {detail} · checked {timeAgo(data.checked_at)}
          </p>
        </div>
      </div>

      {/* Broken things are always visible. Healthy ones stay collapsed so the card
          reads at a glance but the full list is one click away. */}
      {failing.length > 0 && !stale && (
        <div className="mt-3 space-y-0.5">
          {failing.map((c) => (
            <div key={c.name}>
              <CheckRow check={c} />
              <p className="text-xs text-muted-foreground pl-[18px] -mt-0.5 pb-1">{c.detail}</p>
            </div>
          ))}
        </div>
      )}

      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="mt-3 flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors focus-visible:ring-ring focus-visible:ring-[3px] rounded-sm"
        aria-expanded={expanded}
      >
        {expanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
        {expanded ? "Hide" : `Show all ${data.checks.length} checks`}
      </button>

      {expanded && (
        <div className="mt-2 border-t pt-2">
          {ordered.map((c) => (
            <CheckRow key={c.name} check={c} />
          ))}
        </div>
      )}
    </CardShell>
  );
}

/** Data-fetching wrapper used by the Dashboard. */
export function SystemHealthCard() {
  const { data, error } = useQuery<HubHealth>({
    queryKey: ["system-health", "hub"],
    queryFn: () => systemHealthApi.hub(),
    refetchInterval: 60_000,
    retry: false,
  });

  // Not configured (404) or unreadable (503): render nothing rather than a broken card.
  // Deployments without a host monitor should not see this at all.
  if (error || !data) return null;

  return <SystemHealthCardView data={data} />;
}
