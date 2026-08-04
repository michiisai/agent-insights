# Agent Insights

**Agent Insights** brings the OpenTelemetry data your AI agents emit — traces, logs, and metrics — into the editor, and turns it into clear conclusions about how those agents behave.

Explore trace trees, inspect tool calls, identify slow operations, and answer questions like:

- Why did this agent run fail?
- What happened during this session?
- Why was this task slow?
- Which operations, tools, and models consumed the most time or tokens?

There are two ways to use it, over the same data:

- **A panel in the editor** — browse sessions, traces, metrics, and logs by hand across [five tabs](#explore-in-the-panel).
- **Copilot Chat tools** — ten `#`-referenced [language-model tools](#ask-in-copilot-chat) (`#agentSummary`, `#agentErrors`, `#agentSlow`, …) plus a chat skill, so you can just ask *"why did this run fail?"*. The agent can pick the right tool without you naming one, and its answers link straight back to the panel.

## Features

### Explore in the panel

| Tab | What you get |
|-----|-------------|
| **Home** | At-a-glance summary: totals and error rate, token usage by model, latency, tool calls |
| **Sessions** | Agent conversations grouped from traces — outcome, turn-by-turn timeline, correlated logs, and a readable transcript of prompts, responses, reasoning, and tool calls |
| **Traces** | Trace list → span tree with durations and error highlighting, a waterfall view, and full span details |
| **Metrics** | Metric instruments ingested over OTLP, with per-instrument detail |
| **Logs** | Severity-coloured log stream with free-text and severity filters |

Open it from the **Agent Insights** icon in the Activity Bar, or from the status-bar item (`$(broadcast) Agent :4318`).

### Ask in Copilot Chat

Type `#` to reference any of these tools directly. A bundled chat skill also lets the agent pick the right one on its own, so questions like *"why was that run slow?"* work without naming a tool. Trace and span results include links that open the panel at that trace.

| Tool (`#`-reference) | What it does |
|----------------------|--------------|
| `#agentTraces` | Recent traces, with service / time / error filters |
| `#agentSpans` | Full span tree for a given trace |
| `#agentService` | Per-service profile: error rate, p50/p95, slow ops, tokens — good for comparing two agents |
| `#agentSession` | Session summary: outcome, timeline, tool usage, tokens, errors |
| `#agentTranscript` | What was actually said in a session — prompts, responses, reasoning, tool calls |
| `#agentSummary` | High-level health overview across everything received |
| `#agentErrors` | Most recent error traces, with exception details |
| `#agentSlow` | Slowest operations by average duration |
| `#agentLogs` | Keyword and severity search across logs |
| `#agentMetrics` | Token usage and tool call stats in one call |

## Getting started

### 1. Install

Download the latest `.vsix` from the [**newest main build**](https://github.com/michiisai/agent-insights/releases/tag/main-latest) — every push to `main` publishes a fresh one there. Then drag it onto the Extensions view, or:

```bash
gh release download main-latest --repo michiisai/agent-insights --pattern "*.vsix"
code --install-extension agent-insights-*.vsix
```

Reload VS Code. The extension activates on startup, and the status-bar item confirms the receiver is listening.

### 2. Send it some telemetry

Nothing appears until a telemetry source points at the receiver, and **both must use the same port** — the receiver listens on `agentInsights.port` (default `4318`). If `4318` is taken, change it in `settings.json` and use the new port everywhere below.

To capture **VS Code / Copilot's own** agent telemetry, add this to `settings.json`, then reload VS Code and run an agent or chat request:

```jsonc
{
  // Traces and sessions
  "chat.agentHost.enabled": true,
  "chat.agentHost.otel.enabled": true,
  "chat.agentHost.otel.captureContent": true,
  "chat.agentHost.otel.otlpEndpoint": "http://localhost:4318",

  // Metrics and logs
  "github.copilot.chat.otel.enabled": true,
  "github.copilot.chat.otel.captureContent": true,
  "github.copilot.chat.otel.otlpEndpoint": "http://localhost:4318"
}
```


<details>
<summary><b>Claude Code</b></summary>

Add an `env` block to `~/.claude/settings.json`, then start a **new** Claude Code session (settings load at startup) and run a prompt:

```jsonc
{
  "env": {
    "CLAUDE_CODE_ENABLE_TELEMETRY": "1",
    // Export all three signals over OTLP/HTTP JSON to the receiver's port
    "OTEL_TRACES_EXPORTER": "otlp",
    "OTEL_METRICS_EXPORTER": "otlp",
    "OTEL_LOGS_EXPORTER": "otlp",
    "OTEL_EXPORTER_OTLP_PROTOCOL": "http/json",
    "OTEL_EXPORTER_OTLP_ENDPOINT": "http://localhost:4318",
    // Flush metrics every 10s so short sessions still export (default is 60s)
    "OTEL_METRIC_EXPORT_INTERVAL": "10000",
    // Emit cumulative metrics (Claude Code defaults to delta) to match Copilot
    "OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE": "cumulative",
    // Optional: include prompt / tool / response content in logs & spans
    "OTEL_LOG_USER_PROMPTS": "1",
    "OTEL_LOG_TOOL_DETAILS": "1",
    "OTEL_LOG_TOOL_CONTENT": "1"
  }
}
```

Use `http/json` — the receiver speaks OTLP/HTTP JSON, not gRPC or protobuf. Claude Code data appears under the `claude-code` service in each tab.

</details>

<details>
<summary><b>Any other OTLP source</b></summary>

Send OTLP/HTTP JSON to `http://127.0.0.1:<port>`.

Agent-specific views (token usage, tool call analysis) read the OpenTelemetry GenAI semantic-convention keys first, then fall back to the `llm.*` and bare-key variants other harnesses emit — all map onto the same metric:

| Attribute | Meaning |
|-----------|---------|
| `gen_ai.request.model` (or `llm.model`) | Model name (token usage grouping) |
| `gen_ai.usage.input_tokens` (or `llm.usage.prompt_tokens`, `input_tokens`) | Prompt tokens |
| `gen_ai.usage.output_tokens` (or `llm.usage.completion_tokens`, `output_tokens`) | Completion tokens |
| `gen_ai.usage.cache_read_input_tokens` (or `cache_read_tokens`) | Cache-hit tokens (served from cache) |
| `gen_ai.usage.cache_creation_input_tokens` (or `cache_creation_tokens`) | Cache-write tokens (cost of populating the cache) |
| `gen_ai.tool.name` (or `tool.name`, `tool_name`) | Tool name (tool call analysis) |

Metrics of either temporality are handled correctly.

</details>

## Commands

| Command | Description |
|---------|-------------|
| `Agent Insights: Open Panel` | Opens the telemetry panel |
| `Agent Insights: Clear All Data` | Deletes all stored telemetry |
| `Agent Insights: Navigate to Trace` | Opens the panel at a specific trace (used by chat deeplinks) |
| `Agent Insights: Navigate to Session` | Opens the Sessions tab at a specific agent session (used by chat deeplinks) |


## Troubleshooting

**No data appears.** Most often the ports disagree — check `agentInsights.port` against your exporter's endpoint. The status-bar item shows which port is live, and turns into `$(error) Agent` if the receiver failed to start (usually because the port is already taken). Telemetry only arrives once you actually run an agent request after enabling the settings above.

**Traces appear but the Metrics or Logs tab is empty.** Copilot emits traces from one setting and metrics and logs from another, so one can work while the other is off. Check that `github.copilot.chat.otel.enabled` is `true`, reload, and run a chat request. If the Metrics tab has a time range applied, widen it — a metric only shows up if it reported a data point inside the window.

**Data appears in one window but not another.** Only one VS Code window can own the port. Any other window is read-only until you reload it, so keep one window open at a time.
