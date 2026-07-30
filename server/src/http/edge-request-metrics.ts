import type { RequestHandler } from "express";

const STATUS_CLASSES = ["1xx", "2xx", "3xx", "4xx", "5xx"] as const;
type StatusClass = (typeof STATUS_CLASSES)[number];

export type EdgeRequestMetrics = {
  recordStatus(statusCode: number): void;
  renderPrometheus(): string;
  reset(): void;
};

function statusClassFor(statusCode: number): StatusClass | null {
  if (!Number.isInteger(statusCode)) return null;
  const bucket = Math.floor(statusCode / 100);
  if (bucket < 1 || bucket > 5) return null;
  return `${bucket}xx` as StatusClass;
}

export function createEdgeRequestMetrics(): EdgeRequestMetrics {
  const counts = new Map<StatusClass, number>(
    STATUS_CLASSES.map((statusClass) => [statusClass, 0]),
  );

  return {
    recordStatus(statusCode: number) {
      const statusClass = statusClassFor(statusCode);
      if (!statusClass) return;
      counts.set(statusClass, (counts.get(statusClass) ?? 0) + 1);
    },
    renderPrometheus() {
      return [
        "# HELP paperclip_edge_requests_total Paperclip HTTP responses grouped by status class.",
        "# TYPE paperclip_edge_requests_total counter",
        ...STATUS_CLASSES.map(
          (statusClass) =>
            `paperclip_edge_requests_total{status_class="${statusClass}"} ${counts.get(statusClass) ?? 0}`,
        ),
        "",
      ].join("\n");
    },
    reset() {
      for (const statusClass of STATUS_CLASSES) {
        counts.set(statusClass, 0);
      }
    },
  };
}

export const edgeRequestMetrics = createEdgeRequestMetrics();

export function edgeRequestMetricsMiddleware(
  metrics: EdgeRequestMetrics = edgeRequestMetrics,
): RequestHandler {
  return (_req, res, next) => {
    res.on("finish", () => {
      metrics.recordStatus(res.statusCode);
    });
    next();
  };
}
