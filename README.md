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
| **Sessions** | Agent conversations grouped from traces — which agent ran it, outcome, turn-by-turn timeline, correlated logs, and a readable transcript of prompts, responses, reasoning, and tool calls |
| **Traces** | Trace list → span tree with durations and error highlighting, a waterfall view, and full span details |
| **Metrics** | Metric instruments ingested over OTLP, with per-instrument detail |
| **Logs** | Severity-coloured log stream with free-text and severity filters |

Open it from the **Agent Insights** icon in the Activity Bar, or from the status-bar item. Once token-bearing spans arrive, the item shows a compact daily baseline like `$(broadcast) ↓12.4K 42% cached ↑3.1K`. Hover for per-model input, cached, and output counts; click to open the panel. These are tokens seen in received spans, not provider billing.

Free utility models are hidden by default. Adjust the matched name substrings with `agentInsights.utilityModels` (default `["4o", "5.4-nano", "copilot-nes"]`), or set `agentInsights.hideUtilityModels` to `false`. Hidden calls still appear in raw traces and span details.

The Home tab shows the **Background LM Calls** card only after an unfiltered standalone VS Code Language Model API call is detected. Until then, a compact note links to the utility-model filtering settings.

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
| `#agentMetrics` | Available OTLP metric instruments, with service / type / time filters |
| `#agentMetric` | Values, trend, comparison, and dimensions for one OTLP metric |
| `#tokenAndToolUsage` | Token usage and tool call stats in one call |

## Getting started

### 1. Install

Install from the Extensions view — search for **Agent Insights** — or from the command line:

```bash
code --install-extension michiisai.agent-otel
```

Reload VS Code. The extension activates on startup, and the status-bar item confirms the receiver is listening.

> **Every push to `main` publishes a fresh `.vsix`.** To run ahead of the Marketplace release, grab it from the [newest main build](https://github.com/michiisai/agent-insights/releases/tag/main-latest):
>
> ```bash
> gh release download main-latest --repo michiisai/agent-insights --pattern "*.vsix"
> code --install-extension agent-otel-*.vsix
> ```

### 2. Configure telemetry

On recent **VS Code Insiders** builds, Agent Insights can capture native **Copilot, Claude Code, and Codex** sessions. Open Agent Insights and select the gear to view and configure all related settings in one place:

**Required**

- **Chat › Agent Host › OTel: Enabled** — exports Agent Host telemetry.
- **Chat › Agent Host › OTel: OTLP Endpoint** — set to `http://localhost:4318`.

**Enable for the providers you use**

- **Chat › Agent Host › Claude Agent: Enabled** — enables Claude Code sessions.
- **Chat › Agent Host › Codex Agent: Enabled** — enables Codex sessions.
- **GitHub Copilot Chat › OTel: Enabled** — adds Copilot metrics and logs.
- **GitHub Copilot Chat › OTel: OTLP Endpoint** — set to `http://localhost:4318`.

The setup menu shows each setting's current value and offers to reload VS Code after making changes. Start a new agent request after reloading.

> **Optional:** Enable **Capture Content** to include prompts, responses, tool arguments, and file contents. Avoid enabling it when sending data to a shared or untrusted collector. Codex currently exports user prompts but not assistant responses.

Agent Insights uses port `4318` by default. If you change **Agent Insights: Port**, update every **OTLP Endpoint** to match.

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

**Multiple windows show different data.** The first window to launch Agent Insights claims the OTLP port and updates live; other windows show a snapshot. To switch collectors, close the first window and reload another window.
