import fs from "node:fs";
import os from "node:os";
import process from "node:process";
import { performance } from "node:perf_hooks";
import type { RequestHandler } from "express";

type ByteGauge = {
  totalBytes: number | null;
  freeBytes: number | null;
  usedBytes: number | null;
};

type EdgeMetrics = {
  startedAt: string;
  uptimeSeconds: number;
  requestCount: number;
  inflightRequestCount: number;
  statusClasses: Record<string, number>;
  methods: Record<string, number>;
  latencyMs: {
    count: number;
    avg: number | null;
    max: number | null;
  };
};

export type SystemMetricsSnapshot = {
  collectedAt: string;
  host: {
    hostname: string;
    platform: NodeJS.Platform;
    arch: string;
    uptimeSeconds: number;
    loadAverage: {
      "1m": number;
      "5m": number;
      "15m": number;
    };
    cpuCount: number;
    memory: ByteGauge & {
      processRssBytes: number;
      processHeapUsedBytes: number;
      processHeapTotalBytes: number;
    };
    disk: (ByteGauge & { path: string }) | null;
  };
  container: {
    detected: boolean;
    cgroupVersion: "v1" | "v2" | "unknown";
    memory: {
      currentBytes: number | null;
      limitBytes: number | null;
    };
    cpu: {
      quotaCores: number | null;
      usageSeconds: number | null;
      throttledPeriods: number | null;
    };
  };
  edge: EdgeMetrics;
};

export function renderPrometheusSystemMetrics(snapshot: SystemMetricsSnapshot): string {
  const lines: string[] = [
    "# HELP paperclip_host_uptime_seconds Host uptime in seconds.",
    "# TYPE paperclip_host_uptime_seconds gauge",
    `paperclip_host_uptime_seconds ${formatMetricValue(snapshot.host.uptimeSeconds)}`,
    "# HELP paperclip_host_load_average Host load average by time window.",
    "# TYPE paperclip_host_load_average gauge",
    `paperclip_host_load_average{window="1m"} ${formatMetricValue(snapshot.host.loadAverage["1m"])}`,
    `paperclip_host_load_average{window="5m"} ${formatMetricValue(snapshot.host.loadAverage["5m"])}`,
    `paperclip_host_load_average{window="15m"} ${formatMetricValue(snapshot.host.loadAverage["15m"])}`,
    "# HELP paperclip_host_cpu_count Host CPU count visible to the Paperclip process.",
    "# TYPE paperclip_host_cpu_count gauge",
    `paperclip_host_cpu_count ${formatMetricValue(snapshot.host.cpuCount)}`,
    "# HELP paperclip_host_memory_bytes Host and Paperclip process memory in bytes.",
    "# TYPE paperclip_host_memory_bytes gauge",
    ...renderByteGauge("paperclip_host_memory_bytes", snapshot.host.memory, {
      totalBytes: "total",
      freeBytes: "free",
      usedBytes: "used",
      processRssBytes: "process_rss",
      processHeapUsedBytes: "process_heap_used",
      processHeapTotalBytes: "process_heap_total",
    }),
  ];

  if (snapshot.host.disk) {
    lines.push(
      "# HELP paperclip_host_disk_bytes Host filesystem capacity for the Paperclip working directory.",
      "# TYPE paperclip_host_disk_bytes gauge",
      ...renderByteGauge("paperclip_host_disk_bytes", snapshot.host.disk, {
        totalBytes: "total",
        freeBytes: "free",
        usedBytes: "used",
      }, { path: snapshot.host.disk.path }),
    );
  }

  lines.push(
    "# HELP paperclip_container_detected Whether cgroup container metrics were detected.",
    "# TYPE paperclip_container_detected gauge",
    `paperclip_container_detected{cgroup_version="${escapeLabelValue(snapshot.container.cgroupVersion)}"} ${snapshot.container.detected ? 1 : 0}`,
    "# HELP paperclip_container_memory_bytes Container cgroup memory metrics in bytes.",
    "# TYPE paperclip_container_memory_bytes gauge",
    ...renderNullableGauge("paperclip_container_memory_bytes", snapshot.container.memory.currentBytes, { state: "current" }),
    ...renderNullableGauge("paperclip_container_memory_bytes", snapshot.container.memory.limitBytes, { state: "limit" }),
    "# HELP paperclip_container_cpu_quota_cores Container CPU quota in cores.",
    "# TYPE paperclip_container_cpu_quota_cores gauge",
    ...renderNullableGauge("paperclip_container_cpu_quota_cores", snapshot.container.cpu.quotaCores),
    "# HELP paperclip_container_cpu_usage_seconds_total Container CPU usage in seconds.",
    "# TYPE paperclip_container_cpu_usage_seconds_total counter",
    ...renderNullableGauge("paperclip_container_cpu_usage_seconds_total", snapshot.container.cpu.usageSeconds),
    "# HELP paperclip_container_cpu_throttled_periods_total Container CPU throttled periods.",
    "# TYPE paperclip_container_cpu_throttled_periods_total counter",
    ...renderNullableGauge("paperclip_container_cpu_throttled_periods_total", snapshot.container.cpu.throttledPeriods),
    "# HELP paperclip_edge_requests_total HTTP requests observed by the Paperclip edge middleware.",
    "# TYPE paperclip_edge_requests_total counter",
    `paperclip_edge_requests_total ${formatMetricValue(snapshot.edge.requestCount)}`,
    ...Object.entries(snapshot.edge.methods).map(([method, value]) =>
      `paperclip_edge_requests_total{method="${escapeLabelValue(method)}"} ${formatMetricValue(value)}`),
    ...Object.entries(snapshot.edge.statusClasses).map(([statusClass, value]) =>
      `paperclip_edge_requests_total{status_class="${escapeLabelValue(statusClass)}"} ${formatMetricValue(value)}`),
    "# HELP paperclip_edge_inflight_requests Current in-flight HTTP requests observed by the Paperclip edge middleware.",
    "# TYPE paperclip_edge_inflight_requests gauge",
    `paperclip_edge_inflight_requests ${formatMetricValue(snapshot.edge.inflightRequestCount)}`,
    "# HELP paperclip_edge_request_latency_milliseconds HTTP response latency observed by the Paperclip edge middleware.",
    "# TYPE paperclip_edge_request_latency_milliseconds summary",
    `paperclip_edge_request_latency_milliseconds_count ${formatMetricValue(snapshot.edge.latencyMs.count)}`,
    `paperclip_edge_request_latency_milliseconds_sum ${formatMetricValue((snapshot.edge.latencyMs.avg ?? 0) * snapshot.edge.latencyMs.count)}`,
    `paperclip_edge_request_latency_milliseconds{stat="max"} ${formatMetricValue(snapshot.edge.latencyMs.max ?? 0)}`,
  );

  return `${lines.join("\n")}\n`;
}

const edgeStartedAt = new Date();
const edgeCounters = {
  requestCount: 0,
  completedRequestCount: 0,
  inflightRequestCount: 0,
  totalLatencyMs: 0,
  maxLatencyMs: 0,
  statusClasses: new Map<string, number>(),
  methods: new Map<string, number>(),
};

export const edgeMetricsMiddleware: RequestHandler = (req, res, next) => {
  const started = performance.now();
  edgeCounters.requestCount += 1;
  edgeCounters.inflightRequestCount += 1;
  increment(edgeCounters.methods, req.method.toUpperCase());

  res.on("finish", () => {
    const elapsedMs = performance.now() - started;
    edgeCounters.inflightRequestCount = Math.max(0, edgeCounters.inflightRequestCount - 1);
    edgeCounters.completedRequestCount += 1;
    edgeCounters.totalLatencyMs += elapsedMs;
    edgeCounters.maxLatencyMs = Math.max(edgeCounters.maxLatencyMs, elapsedMs);
    increment(edgeCounters.statusClasses, `${Math.floor(res.statusCode / 100)}xx`);
  });

  next();
};

export function collectSystemMetrics(opts: { diskPath?: string } = {}): SystemMetricsSnapshot {
  const memoryTotalBytes = os.totalmem();
  const memoryFreeBytes = os.freemem();
  const memoryUsedBytes = memoryTotalBytes - memoryFreeBytes;
  const memoryUsage = process.memoryUsage();
  const loadAverage = os.loadavg();
  const container = collectContainerMetrics();

  return {
    collectedAt: new Date().toISOString(),
    host: {
      hostname: os.hostname(),
      platform: process.platform,
      arch: process.arch,
      uptimeSeconds: os.uptime(),
      loadAverage: {
        "1m": loadAverage[0] ?? 0,
        "5m": loadAverage[1] ?? 0,
        "15m": loadAverage[2] ?? 0,
      },
      cpuCount: os.availableParallelism?.() ?? os.cpus().length,
      memory: {
        totalBytes: memoryTotalBytes,
        freeBytes: memoryFreeBytes,
        usedBytes: memoryUsedBytes,
        processRssBytes: memoryUsage.rss,
        processHeapUsedBytes: memoryUsage.heapUsed,
        processHeapTotalBytes: memoryUsage.heapTotal,
      },
      disk: collectDiskMetrics(opts.diskPath ?? process.cwd()),
    },
    container,
    edge: snapshotEdgeMetrics(),
  };
}

function snapshotEdgeMetrics(): EdgeMetrics {
  const requestCount = edgeCounters.requestCount;
  const completedRequestCount = edgeCounters.completedRequestCount;
  return {
    startedAt: edgeStartedAt.toISOString(),
    uptimeSeconds: Math.max(0, (Date.now() - edgeStartedAt.getTime()) / 1000),
    requestCount,
    inflightRequestCount: edgeCounters.inflightRequestCount,
    statusClasses: Object.fromEntries(edgeCounters.statusClasses.entries()),
    methods: Object.fromEntries(edgeCounters.methods.entries()),
    latencyMs: {
      count: completedRequestCount,
      avg: completedRequestCount > 0 ? edgeCounters.totalLatencyMs / completedRequestCount : null,
      max: completedRequestCount > 0 ? edgeCounters.maxLatencyMs : null,
    },
  };
}

function collectDiskMetrics(targetPath: string): SystemMetricsSnapshot["host"]["disk"] {
  try {
    const stats = fs.statfsSync(targetPath);
    const totalBytes = stats.blocks * stats.bsize;
    const freeBytes = stats.bavail * stats.bsize;
    return {
      path: targetPath,
      totalBytes,
      freeBytes,
      usedBytes: totalBytes - freeBytes,
    };
  } catch {
    return null;
  }
}

function collectContainerMetrics(): SystemMetricsSnapshot["container"] {
  const v2Root = "/sys/fs/cgroup";
  const cgroupVersion = fs.existsSync(`${v2Root}/cgroup.controllers`)
    ? "v2"
    : fs.existsSync("/proc/self/cgroup")
      ? "v1"
      : "unknown";
  const memoryCurrent = readNumberFile(`${v2Root}/memory.current`) ?? readNumberFile("/sys/fs/cgroup/memory/memory.usage_in_bytes");
  const memoryLimit = readMaxNumberFile(`${v2Root}/memory.max`) ?? readMaxNumberFile("/sys/fs/cgroup/memory/memory.limit_in_bytes");
  const cpuUsageMicros = readKeyValueFile(`${v2Root}/cpu.stat`).usage_usec;
  const cpuUsageNanos = readNumberFile("/sys/fs/cgroup/cpuacct/cpuacct.usage");
  const cpuMax = readTextFile(`${v2Root}/cpu.max`);
  const quotaCores = parseCpuQuotaCores(cpuMax);
  const throttledPeriods =
    readKeyValueFile(`${v2Root}/cpu.stat`).nr_throttled ??
    readKeyValueFile("/sys/fs/cgroup/cpu/cpu.stat").nr_throttled ??
    null;

  return {
    detected: cgroupVersion !== "unknown" && (memoryCurrent !== null || memoryLimit !== null || quotaCores !== null),
    cgroupVersion,
    memory: {
      currentBytes: memoryCurrent,
      limitBytes: memoryLimit,
    },
    cpu: {
      quotaCores,
      usageSeconds:
        cpuUsageMicros !== null && cpuUsageMicros !== undefined
          ? cpuUsageMicros / 1_000_000
          : cpuUsageNanos !== null
            ? cpuUsageNanos / 1_000_000_000
            : null,
      throttledPeriods,
    },
  };
}

function parseCpuQuotaCores(value: string | null): number | null {
  if (!value) return null;
  const [quotaRaw, periodRaw] = value.trim().split(/\s+/);
  if (!quotaRaw || quotaRaw === "max") return null;
  const quota = Number(quotaRaw);
  const period = Number(periodRaw);
  if (!Number.isFinite(quota) || !Number.isFinite(period) || period <= 0) return null;
  return quota / period;
}

function readTextFile(path: string): string | null {
  try {
    return fs.readFileSync(path, "utf8").trim();
  } catch {
    return null;
  }
}

function readNumberFile(path: string): number | null {
  const value = readTextFile(path);
  if (!value) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function readMaxNumberFile(path: string): number | null {
  const value = readTextFile(path);
  if (!value || value === "max") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function readKeyValueFile(path: string): Record<string, number> {
  const value = readTextFile(path);
  if (!value) return {};

  const parsed: Record<string, number> = {};
  for (const line of value.split("\n")) {
    const [key, raw] = line.trim().split(/\s+/);
    const numeric = Number(raw);
    if (key && Number.isFinite(numeric)) parsed[key] = numeric;
  }
  return parsed;
}

function increment(map: Map<string, number>, key: string) {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function renderByteGauge(
  metricName: string,
  source: Record<string, number | string | null>,
  states: Record<string, string>,
  extraLabels: Record<string, string> = {},
): string[] {
  return Object.entries(states).flatMap(([key, state]) =>
    renderNullableGauge(metricName, typeof source[key] === "number" ? source[key] : null, { ...extraLabels, state }),
  );
}

function renderNullableGauge(
  metricName: string,
  value: number | null,
  labels: Record<string, string> = {},
): string[] {
  if (value === null) return [];
  const labelText = renderLabels(labels);
  return [`${metricName}${labelText} ${formatMetricValue(value)}`];
}

function renderLabels(labels: Record<string, string>): string {
  const entries = Object.entries(labels);
  if (entries.length === 0) return "";
  return `{${entries.map(([key, value]) => `${key}="${escapeLabelValue(value)}"`).join(",")}}`;
}

function escapeLabelValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/"/g, "\\\"");
}

function formatMetricValue(value: number): string {
  if (!Number.isFinite(value)) return "0";
  return String(value);
}
