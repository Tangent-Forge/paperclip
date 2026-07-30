# Observability

Paperclip ships with **opt-in** OpenTelemetry auto-instrumentation for the
server process. When activated it produces **traces only** — no metrics and no
logs are exported by this integration. The OTel packages are *optional peer
dependencies*: they are not in the default lockfile and are loaded dynamically
only when an operator turns the feature on.

When `OTEL_EXPORTER_OTLP_ENDPOINT` is unset, none of the `@opentelemetry/*`
packages are imported and there is zero runtime overhead.

## Runtime dashboards and alerts

The repo includes a source-controlled observability bundle under
`infra/observability/` for the Tangent Forge control-plane runtime. Paperclip
also exposes a small Prometheus metrics endpoint at `/api/health/metrics` for
edge request status-class counters. The bundle loads host, container, tunnel,
edge, Caddy, and blackbox probe metrics into Prometheus/Grafana when operators
run the observability stack.

Provisioning files:

| Purpose | Path |
| --- | --- |
| Docker LGTM overlay | `infra/observability/docker-compose.lgtm.yml` |
| Host-native Prometheus config | `infra/observability/prometheus/prometheus.host.yml` |
| Docker Prometheus config | `infra/observability/prometheus/prometheus.docker.yml` |
| Alert rules | `infra/observability/prometheus/alerts/paperclip-runtime-alerts.yml` |
| Blackbox exporter config | `infra/observability/blackbox/blackbox.yml` |
| Grafana datasource provisioning | `infra/observability/grafana/provisioning/datasources/prometheus.yml` |
| Grafana dashboard provisioning | `infra/observability/grafana/provisioning/dashboards/paperclip-runtime.yml` |
| Grafana dashboard JSON | `infra/observability/grafana/provisioning/dashboards/json/paperclip-runtime-health.json` |

Metric provenance is explicit:

| Dashboard/alert metric | Source |
| --- | --- |
| `paperclip_host_cpu_usage_ratio` | Recording rule from `node_cpu_seconds_total{job="paperclip-host"}` |
| `paperclip_host_memory_used_bytes` | Recording rule from `node_memory_MemTotal_bytes` minus `node_memory_MemAvailable_bytes` |
| `paperclip_host_memory_total_bytes` | Recording rule from `node_memory_MemTotal_bytes` |
| `paperclip_host_load1` | Recording rule from `node_load1{job="paperclip-host"}` |
| `paperclip_container_running` | Recording rule from cAdvisor `container_last_seen{job="paperclip-containers"}` |
| `paperclip_container_restart_events_15m` | Recording rule from cAdvisor `container_start_time_seconds{job="paperclip-containers"}` |
| `paperclip_edge_requests_total{status_class="..."}` | Paperclip server `/api/health/metrics` scraped by the `paperclip-edge` job; the CTO contract label is `status_class`, for example `status_class="5xx"` |
| `cloudflared_*` | Cloudflared metrics endpoint |
| `caddy_http_requests_total` | Caddy admin metrics endpoint |
| `probe_success`, `probe_http_duration_seconds` | Blackbox exporter |

Host-native Prometheus expects local exporters on loopback:

| Job | Target | Expected exporter |
| --- | --- | --- |
| `paperclip-host` | `localhost:9100` | node-exporter |
| `paperclip-containers` | `localhost:9101` | cAdvisor |
| `paperclip-edge` | `localhost:3100/api/health/metrics` | Paperclip server Prometheus endpoint emitting `paperclip_edge_requests_total{status_class="..."}` |
| `cloudflared` | `localhost:20241` | cloudflared metrics |
| `caddy` | `localhost:2019` | Caddy admin metrics |
| `paperclip-service-probes` | `localhost:9115` | blackbox exporter |

Host-native Prometheus loads rules with:

```bash
prometheus --config.file=infra/observability/prometheus/prometheus.host.yml
```

The Docker observability stack loads the Docker Prometheus config and the same
alert rule directory with:

```bash
docker compose -f infra/observability/docker-compose.lgtm.yml config
docker compose -f infra/observability/docker-compose.lgtm.yml up -d prometheus blackbox node-exporter cadvisor grafana
```

The second command starts observability services only. The Docker overlay binds
Prometheus, Grafana, blackbox exporter, node-exporter, and cAdvisor to loopback
ports. Do not use it as a verification step against a production host unless a
service-start/restart window has been approved.

### Dashboard panels

Open Grafana at `http://localhost:3001/` and select
`Paperclip / Paperclip Runtime Health`.

| Panel | Primary metrics |
| --- | --- |
| Host Availability | `up{job="paperclip-host"}` |
| Host CPU Usage | `paperclip_host_cpu_usage_ratio` |
| Host Memory Usage | `paperclip_host_memory_used_bytes`, `paperclip_host_memory_total_bytes` |
| Host Load | `paperclip_host_load1` |
| Container Running State | `paperclip_container_running` |
| Container Restarts | `paperclip_container_restart_events_15m` |
| Tunnel Availability | `up{job="cloudflared"}` |
| Tunnel HA Connections | `cloudflared_tunnel_ha_connections` |
| Edge Request Rate | `paperclip_edge_requests_total` |
| Edge 5xx Rate | `paperclip_edge_requests_total` |
| Caddy 5xx Rate | `caddy_http_requests_total` |
| Service Probe Status | `probe_success` for Hermes, GBrain, OpenWebUI, and Ollama |
| Service Probe Latency | `probe_http_duration_seconds{phase="total"}` |

### First-response commands

Use these commands before changing services:

```bash
curl -fsS http://localhost:9090/-/ready
curl -fsS 'http://localhost:9090/api/v1/targets?state=any'
curl -G http://localhost:9090/api/v1/query --data-urlencode 'query=ALERTS{alertstate="firing"}'
curl -G http://localhost:9090/api/v1/query --data-urlencode 'query=probe_success{job="paperclip-service-probes"}'
docker compose -f infra/observability/docker-compose.lgtm.yml ps
docker ps --format '{{.Names}}\t{{.Status}}' | rg 'paperclip|cloudflared|caddy|prometheus|grafana|blackbox'
ss -ltnp | rg ':(3000|3100|3131|8642|11434|2019|20241|9090|9115)'
```

## Runtime alert runbooks

<a id="paperclipserviceprobedownwarning--paperclipserviceprobedowncritical"></a>
### PaperclipServiceProbeDownWarning / PaperclipServiceProbeDownCritical

Dashboard panel: `Service Probe Status`

Metrics: `probe_success{job="paperclip-service-probes"}`

First response:

```bash
curl -G http://localhost:9090/api/v1/query --data-urlencode 'query=probe_success{job="paperclip-service-probes"}'
curl -fsS http://localhost:8642/health
curl -fsS http://localhost:3131/health
curl -fsS http://localhost:3000/
curl -fsS http://localhost:11434/
ss -ltnp | rg ':(8642|3131|3000|11434)'
```

If only `probe_success` is failing and the service responds locally, inspect the
blackbox exporter target and network path before restarting the service.

<a id="paperclipserviceprobelatencywarning--paperclipserviceprobelatencycritical"></a>
### PaperclipServiceProbeLatencyWarning / PaperclipServiceProbeLatencyCritical

Dashboard panel: `Service Probe Latency`

Metrics: `probe_http_duration_seconds{job="paperclip-service-probes",phase="total"}`

First response:

```bash
curl -G http://localhost:9090/api/v1/query --data-urlencode 'query=probe_http_duration_seconds{job="paperclip-service-probes",phase="total"}'
curl -w 'total=%{time_total}s status=%{http_code}\n' -o /dev/null -s http://localhost:8642/health
curl -w 'total=%{time_total}s status=%{http_code}\n' -o /dev/null -s http://localhost:3131/health
curl -w 'total=%{time_total}s status=%{http_code}\n' -o /dev/null -s http://localhost:3000/
curl -w 'total=%{time_total}s status=%{http_code}\n' -o /dev/null -s http://localhost:11434/
```

Compare local latency with Grafana's `Service Probe Latency` panel. If local
latency is normal, inspect Prometheus and blackbox exporter scheduling/load.

<a id="papercliphostcpuhighwarning--papercliphostcpuhighcritical"></a>
### PaperclipHostCpuHighWarning / PaperclipHostCpuHighCritical

Dashboard panel: `Host CPU Usage`

Metrics: `paperclip_host_cpu_usage_ratio`, `paperclip_host_load1`

First response:

```bash
curl -G http://localhost:9090/api/v1/query --data-urlencode 'query=avg(paperclip_host_cpu_usage_ratio) * 100'
uptime
ps -eo pid,ppid,pcpu,pmem,comm,args --sort=-pcpu | head -20
```

Identify the top process before restarting anything. If an agent run is the top
consumer, inspect its issue/run state and budget posture first.

<a id="papercliphostmemoryhighwarning--papercliphostmemoryhighcritical"></a>
### PaperclipHostMemoryHighWarning / PaperclipHostMemoryHighCritical

Dashboard panel: `Host Memory Usage`

Metrics: `paperclip_host_memory_used_bytes`,
`paperclip_host_memory_total_bytes`

First response:

```bash
curl -G http://localhost:9090/api/v1/query --data-urlencode 'query=avg(paperclip_host_memory_used_bytes / paperclip_host_memory_total_bytes) * 100'
free -h
ps -eo pid,ppid,pcpu,pmem,comm,args --sort=-pmem | head -20
```

Look for runaway runs, browser sessions, and model workers before changing
service state.

<a id="paperclipcontainerdownwarning--paperclipcontainerdowncritical"></a>
### PaperclipContainerDownWarning / PaperclipContainerDownCritical

Dashboard panel: `Container Running State`

Metrics: `paperclip_container_running`

First response:

```bash
curl -G http://localhost:9090/api/v1/query --data-urlencode 'query=paperclip_container_running'
docker ps --format '{{.Names}}\t{{.Status}}'
docker ps -a --format '{{.Names}}\t{{.Status}}\t{{.Image}}' | rg 'paperclip|postgres|prometheus|grafana|blackbox'
docker logs --tail 100 <container-name>
```

Confirm whether the container is expected to run on this host before taking
recovery action.

<a id="paperclipcontainerrestartwarning--paperclipcontainerrestartcritical"></a>
### PaperclipContainerRestartWarning / PaperclipContainerRestartCritical

Dashboard panel: `Container Restarts`

Metrics: `paperclip_container_restart_events_15m`

First response:

```bash
curl -G http://localhost:9090/api/v1/query --data-urlencode 'query=paperclip_container_restart_events_15m'
docker ps -a --format '{{.Names}}\t{{.Status}}\t{{.Image}}' | rg 'paperclip|postgres|prometheus|grafana|blackbox'
docker logs --tail 200 <container-name>
docker inspect <container-name> --format '{{.State.ExitCode}} {{.State.Error}}'
```

Treat repeated restarts as a live incident. Preserve logs before applying a fix.

<a id="papercliptunneldownwarning--papercliptunneldowncritical"></a>
### PaperclipTunnelDownWarning / PaperclipTunnelDownCritical

Dashboard panel: `Tunnel Availability`

Metrics: `up{job="cloudflared"}`, `cloudflared_*`

First response:

```bash
curl -G http://localhost:9090/api/v1/query --data-urlencode 'query=up{job="cloudflared"}'
curl -fsS http://localhost:20241/metrics | rg 'cloudflared'
docker ps --format '{{.Names}}\t{{.Status}}' | rg cloudflared
docker logs --tail 100 <cloudflared-container-name>
```

This confirms metrics reachability only. Do not change Cloudflare routes or
tunnel credentials without explicit operator approval.

<a id="papercliptunnelnohaconnectionswarning--papercliptunnelnohaconnectionscritical"></a>
### PaperclipTunnelNoHaConnectionsWarning / PaperclipTunnelNoHaConnectionsCritical

Dashboard panel: `Tunnel HA Connections`

Metrics: `cloudflared_tunnel_ha_connections`

First response:

```bash
curl -G http://localhost:9090/api/v1/query --data-urlencode 'query=cloudflared_tunnel_ha_connections'
curl -fsS http://localhost:20241/metrics | rg 'cloudflared_tunnel_ha_connections'
docker logs --tail 100 <cloudflared-container-name>
```

If HA connections are zero but `cloudflared` is running, inspect upstream tunnel
connectivity and Cloudflare status read-only. Route or credential changes remain
approval-gated.

<a id="paperclipedge5xxratewarning--paperclipedge5xxratecritical"></a>
### PaperclipEdge5xxRateWarning / PaperclipEdge5xxRateCritical

Dashboard panel: `Edge 5xx Rate`

Metrics: `paperclip_edge_requests_total{status_class="..."}`

First response:

```bash
curl -G http://localhost:9090/api/v1/query --data-urlencode 'query=sum(rate(paperclip_edge_requests_total{status_class="5xx"}[5m])) / clamp_min(sum(rate(paperclip_edge_requests_total[5m])), 1)'
curl -G http://localhost:9090/api/v1/query --data-urlencode 'query=sum by (status_class) (rate(paperclip_edge_requests_total[5m]))'
curl -fsS http://localhost:3100/api/health/metrics | rg 'paperclip_edge_requests_total'
curl -fsS http://localhost:3100/api/health || curl -fsS http://localhost:3100/
```

Correlate edge errors with Paperclip server reachability and Caddy 5xx before
changing tunnel or route configuration.

<a id="paperclipcaddy5xxratewarning--paperclipcaddy5xxratecritical"></a>
### PaperclipCaddy5xxRateWarning / PaperclipCaddy5xxRateCritical

Dashboard panel: `Caddy 5xx Rate`

Metrics: `caddy_http_requests_total`

First response:

```bash
curl -G http://localhost:9090/api/v1/query --data-urlencode 'query=sum(rate(caddy_http_requests_total{code=~"5.."}[5m])) / clamp_min(sum(rate(caddy_http_requests_total[5m])), 1)'
curl -fsS http://localhost:2019/metrics | rg 'caddy_http_requests_total'
curl -fsS http://localhost:3100/api/health || curl -fsS http://localhost:3100/
```

Use this to distinguish Caddy/proxy failures from Paperclip application
failures. Caddy admin/API changes are runtime config changes and require
approval.

### Known blind spots

- Hermes, GBrain, OpenWebUI, and Ollama are blackbox-only in this bundle:
  `probe_success` and `probe_http_duration_seconds` prove endpoint reachability
  and latency, not internal queue health, model saturation, data freshness, or
  correctness.
- Paperclip's built-in OTel integration emits traces only and remains optional.
  If `OTEL_EXPORTER_OTLP_ENDPOINT` is unset, trace panels and trace-to-log
  workflows will be empty by design.
- `paperclip_host_*` and `paperclip_container_*` are recording-rule outputs.
  If node-exporter or cAdvisor is missing, those series will be absent.
- `paperclip_edge_requests_total` is emitted by the Paperclip server process.
  It covers requests that reach Paperclip and uses `status_class` labels such
  as `2xx`, `4xx`, and `5xx`; it is not a CDN or tunnel-native edge metric.
- `cloudflared_*` and `caddy_*` panels require the corresponding local metrics
  endpoints to be enabled and reachable by Prometheus.
- The Docker Prometheus config reaches host-native services through
  `host.docker.internal`; Linux hosts need Docker's `host-gateway` support,
  which is declared in `infra/observability/docker-compose.lgtm.yml`.

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
