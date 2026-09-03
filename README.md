# Agent Insights

**Agent Insights** brings the OpenTelemetry data your AI agents emit — traces, logs, and metrics — into the editor, and turns it into clear conclusions about how those agents behave.

Explore trace trees, inspect tool calls, identify slow operations, and answer questions like:

- Why did this agent run fail?
- What happened during this session?
- Why was this task slow?
- Which operations, tools, and models consumed the most time or tokens?

There are two ways to use it, over the same data:

- **A panel in the editor** — browse sessions, traces, metrics, and logs by hand across [five tabs](#explore-in-the-panel).
- **Copilot Chat tools** — twelve `#`-referenced [language-model tools](#ask-in-copilot-chat) (`#agentSummary`, `#agentErrors`, `#agentSlow`, …) plus a chat skill, so you can just ask *"why did this run fail?"*. The agent can pick the right tool without you naming one, and its answers link straight back to the panel.

## Features

### Explore in the panel

| Tab | What you get |
|-----|-------------|
| **Home** | At-a-glance summary: totals and error rate, token usage by model, latency, tool calls, and background LM calls |
| **Sessions** | Agent conversations grouped from traces — which agent ran it, outcome, turn-by-turn timeline, correlated logs, and captured prompts, responses, reasoning, and tool calls when available |
| **Traces** | Trace list → span tree with durations and error highlighting, a waterfall view, and full span details |
| **Metrics** | Metric instruments ingested over OTLP, with per-instrument detail |
| **Logs** | Severity-coloured log stream with free-text and severity filters |

Open the panel from the **Agent Insights** icon in the Activity Bar or from the status-bar item. Once token-bearing spans arrive, the status bar shows today's observed input tokens, cache hit rate, and output tokens, such as `↓12.4K 42% ↑3.1K`. Hover for per-model details. These values come from received spans and may differ from provider billing.

Aggregate and model views hide configured utility models by default. Adjust `agentInsights.utilityModels` or disable `agentInsights.hideUtilityModels`; hidden calls remain available in raw traces and span details.

### Ask in Copilot Chat

Type `#` to reference any of these tools directly. A bundled chat skill also lets the agent choose a tool automatically, so questions like *"why was that run slow?"* work without naming one. Results include links back to relevant sessions and traces in the panel.

| Tool (`#`-reference) | What it does |
|----------------------|--------------|
| `#agentTraces` | Recent traces, with service / time / error filters |
| `#agentSpans` | Trace summary, important spans, and targeted span details |
| `#agentService` | Per-service profile: error rate, p50/p95, slow ops, tokens — good for comparing two agents |
| `#agentSession` | Session summary: outcome, timeline, tool usage, tokens, errors |
| `#agentTranscript` | Captured prompts, responses, reasoning, and tool activity for a session |
| `#agentSummary` | High-level health overview across everything received |
| `#agentErrors` | Most recent error traces, with exception details |
| `#agentSlow` | Slowest operations by average duration |
| `#agentLogs` | Keyword and severity search across logs |
| `#agentMetrics` | Available OTLP metric instruments, with service / type / time filters |
| `#agentMetric` | Values, trend, comparison, and dimensions for one OTLP metric |
| `#tokenAndToolUsage` | Token usage and tool call stats in one call |

## Getting started

### 1. Install

Install from the Extensions view — search for **Agent Insights** — or from the command line:

```bash
code --install-extension michiisai.agent-otel
```

Reload VS Code. The extension activates on startup, and the status-bar item reports the receiver status; hover it for details.

To try changes newer than the Marketplace release, install the [latest development build](https://github.com/michiisai/agent-insights/releases/tag/main-latest):

```bash
gh release download main-latest --repo michiisai/agent-insights --pattern "*.vsix"
code --install-extension agent-otel-*.vsix
```

### 2. Configure telemetry

Agent Insights receives OTLP/HTTP JSON on port `4318` by default.

> **Warning: Unauthenticated telemetry endpoint.** Any application on your machine can send unverified telemetry to Agent Insights. The receiver accepts connections only from your machine.

#### Native VS Code agents

Agent Insights can capture native **Copilot, Claude Code, and Codex** sessions. Open the panel and select the gear to configure them:

- **Chat › Agent Host › OTel: Enabled** — required to export Agent Host telemetry.
- **Chat › Agent Host › OTel: OTLP Endpoint** — set to `http://localhost:4318`.
- **Chat › Agent Host › Claude Agent: Enabled** — enable if you use Claude Code.
- **Chat › Agent Host › Codex Agent: Enabled** — enable if you use Codex.
- **GitHub Copilot Chat › OTel: Enabled** — enable to add Copilot metrics and logs.
- **GitHub Copilot Chat › OTel: OTLP Endpoint** — set to `http://localhost:4318`.

The setup menu shows which settings are available and offers to reload VS Code after changes. Start a new agent request after reloading.

> **Optional:** Enable **Capture Content** to include prompts, responses, tool arguments, and file contents. Captured content may be sensitive, and availability varies by provider.

All OTLP endpoints must match **Agent Insights: Port** (`4318` by default). Changing the port through the setup menu updates supported VS Code endpoints automatically. Update any other exporters manually.

#### Other OTLP sources

Agent Insights can also receive data from agents and applications that already export OTLP/HTTP JSON. Send them to the standard `/v1/traces`, `/v1/metrics`, or `/v1/logs` path on `http://127.0.0.1:<agent-insights-port>`.

## Data storage

Telemetry is stored locally in VS Code's extension storage. Raw traces, metrics, and logs have bounded row and storage limits, so older data may be removed as telemetry volume grows. Use **Clear** in the panel or run **Agent Insights: Clear All Data** to delete all stored telemetry.

## Troubleshooting

**No data appears.** Check that the receiver port in the status-bar tooltip matches every exporter endpoint. For native VS Code agents, reload after changing settings and start a new agent request. Other exporters must send OTLP/HTTP JSON to the signal-specific paths above.

**Traces appear but the Metrics or Logs tab is empty.** Copilot emits traces from one setting and metrics and logs from another, so one can work while the other is off. Check that `github.copilot.chat.otel.enabled` is `true`, reload, and run a chat request. If the Metrics tab has a time range applied, widen it — a metric only shows up if it reported a data point inside the window.

**Multiple windows show different data.** The first window to launch Agent Insights claims the OTLP port and updates live; other windows show a snapshot. To switch collectors, close the first window and reload another window.
