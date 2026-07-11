# Observability

Paperclip ships with **opt-in** OpenTelemetry auto-instrumentation for the
server process. When activated it produces **traces only** — no metrics and no
logs are exported by this integration. The OTel packages are *optional peer
dependencies*: they are not in the default lockfile and are loaded dynamically
only when an operator turns the feature on.

When `OTEL_EXPORTER_OTLP_ENDPOINT` is unset, none of the `@opentelemetry/*`
packages are imported and there is zero runtime overhead.

## Enabling tracing

### 1. Install the OTel peer dependencies

Install the SDK, the auto-instrumentations bundle, the resources/semconv
helpers, and **one** exporter matching your chosen OTLP protocol.

Common to every protocol:

```bash
pnpm add \
  @opentelemetry/sdk-node \
  @opentelemetry/auto-instrumentations-node \
  @opentelemetry/resources \
  @opentelemetry/semantic-conventions
```

Then add the exporter for the protocol you intend to use:

| `OTEL_EXPORTER_OTLP_PROTOCOL` | Exporter package                              |
| ----------------------------- | --------------------------------------------- |
| `grpc` (default if unset)     | `@opentelemetry/exporter-trace-otlp-grpc`     |
| `http/protobuf`               | `@opentelemetry/exporter-trace-otlp-proto`    |
| `http/json`                   | `@opentelemetry/exporter-trace-otlp-http`     |

For example, for the default gRPC path:

```bash
pnpm add @opentelemetry/exporter-trace-otlp-grpc
```

### 2. Set the environment

Minimal setup:

```bash
# Required — turns the feature on. Point at your collector.
# For grpc this is the gRPC target (typically port 4317). For the HTTP
# protocols give the collector's BASE URL (typically port 4318) — the
# exporter appends /v1/traces itself.
export OTEL_EXPORTER_OTLP_ENDPOINT="http://otel-collector:4317"

# Optional — protocol. Defaults to grpc when unset.
# Valid values: grpc | http/protobuf | http/json
export OTEL_EXPORTER_OTLP_PROTOCOL="grpc"

# Optional — service identity attached to every span.
export OTEL_SERVICE_NAME="paperclip"
export OTEL_SERVICE_VERSION="2026.5.0"
```

If `OTEL_EXPORTER_OTLP_PROTOCOL` is set to an unrecognized value, Paperclip
logs a single warning and falls back to gRPC.

If `OTEL_EXPORTER_OTLP_ENDPOINT` is set but the OTel packages are not
installed, the server logs a single diagnostic line on boot and continues
without tracing — your server stays up.

## Trace propagation

Paperclip supports W3C Trace Context propagation for `traceparent` and
`tracestate` only. Incoming API requests extract those headers when tracing is
enabled, and Paperclip forwards the active context across supported internal
boundaries: server/CLI Paperclip API calls, heartbeat adapter launches via
`OTEL_TRACEPARENT`/`OTEL_TRACESTATE`, sandbox callback bridge requests, and the
plugin host-worker JSON-RPC invocation envelope.

Baggage is intentionally unsupported and is not forwarded. Browser UI traces,
arbitrary plugin outbound requests, adapter vendor API calls, and edge worker
paths are also out of scope for this server integration.

## Scope

This integration emits **traces only**. Metrics and log exporters are out of
scope and intentionally not configured here. Auto-instrumentations for
`fs`, `dns`, and `net` are disabled by default because they are too chatty
for this workload; everything else from
`@opentelemetry/auto-instrumentations-node` is on (HTTP, Express, PG, etc.).

## Metrics Collection

Paperclip also exposes a separate, repo-controlled Prometheus metrics path at
`GET /api/health/metrics`. This endpoint is not part of the OpenTelemetry
tracing integration above. It renders text-format Prometheus metrics for:

- host uptime, CPU count, load, memory, and working-directory disk capacity
- Docker/container cgroup memory and CPU counters when cgroups are visible
- Paperclip process memory gauges
- Paperclip edge middleware request count, status-class count, method count,
  in-flight requests, and latency summary values

The route is observe-only. In authenticated deployments it follows the same
full-health-details gate as `GET /api/health`: board and agent actors can read
it, anonymous callers cannot.

### Repo-Controlled Scrape Config

Use `infra/observability/prometheus/prometheus.yml` as the source-controlled
scrape plan for the control-plane observability stack. It covers:

| Component | Collection path | Evidence type |
| --- | --- | --- |
| Host | `paperclip_host_*` from `127.0.0.1:3100/api/health/metrics` | native gauges |
| Docker/container | `paperclip_container_*` from `127.0.0.1:3100/api/health/metrics` | native cgroup gauges/counters |
| Paperclip service | `paperclip_host_memory_bytes{state="process_*"}` and `paperclip_edge_*` from `127.0.0.1:3100/api/health/metrics` | native gauges/counters |
| Edge Worker path | `paperclip_edge_*` request middleware counters from `127.0.0.1:3100/api/health/metrics` | native counters/summary |
| Cloudflared | `127.0.0.1:20241/metrics` | Cloudflared Prometheus endpoint |
| Caddy | `127.0.0.1:2019/metrics` | Caddy admin Prometheus endpoint |
| Hermes | blackbox TCP probes for `127.0.0.1:8642` and `127.0.0.1:3978` | private TCP probe |
| GBrain | blackbox HTTP probe for `http://127.0.0.1:3131/health` | private HTTP probe |
| OpenWebUI | blackbox HTTP probe for `http://127.0.0.1:3000` | private HTTP probe |
| Ollama | blackbox TCP probe for `127.0.0.1:11434` | private TCP probe |

The blackbox jobs assume a blackbox exporter is already running on
`127.0.0.1:9115`. They do not expose Paperclip, Hermes, GBrain, OpenWebUI,
Ollama, Caddy, or Cloudflared publicly.

### Sample Evidence

These samples were collected on 2026-07-11 from private loopback
targets. Values are examples only; operators should expect them to change.

Paperclip service, host, container, and edge route evidence is covered by the
unit fixture in `server/src/__tests__/health.test.ts`, which asserts exported
lines such as:

```text
paperclip_host_uptime_seconds 123
paperclip_host_memory_bytes{state="process_rss"} 100
paperclip_host_disk_bytes{path="/workspace",state="used"} 500
paperclip_container_detected{cgroup_version="v2"} 1
paperclip_container_memory_bytes{state="current"} 300
paperclip_edge_requests_total 7
paperclip_edge_requests_total{method="GET"} 7
paperclip_edge_requests_total{status_class="5xx"} 1
paperclip_edge_request_latency_milliseconds_count 7
```

Cloudflared exposed its private metrics listener on `127.0.0.1:20241`:

```text
build_info{goversion="go1.26.4",revision="2026-06-18-14:33 UTC",type="",version="2026.6.1"} 1
cloudflared_config_local_config_pushes 1
cloudflared_config_local_config_pushes_errors 0
cloudflared_icmp_total_replies 0
```

Caddy exposed its private admin metrics endpoint on `127.0.0.1:2019`:

```text
go_build_info{checksum="",path="",version=""} 1
go_gc_duration_seconds_sum 0.041261882
go_gc_duration_seconds_count 728
```

Hermes, GBrain, OpenWebUI, and Ollama do not currently expose native
Prometheus metrics on their private service ports. The repository-controlled
collection path therefore uses blackbox health probes:

```text
127.0.0.1:8642  hermes gateway TCP listener
127.0.0.1:3978  hermes webhook/API TCP listener
127.0.0.1:3131  gbrain HTTP listener
127.0.0.1:3000  OpenWebUI HTTP listener
127.0.0.1:11434 Ollama TCP listener
```
