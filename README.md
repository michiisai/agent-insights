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
| **Home** | At-a-glance summary: totals and error rate, token usage by model, latency, tool calls, and background LM calls |
| **Sessions** | Agent conversations grouped from traces — which agent ran it, outcome, turn-by-turn timeline, correlated logs, and a readable transcript of prompts, responses, reasoning, and tool calls |
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
| `#tokenAndToolUsage` | Token usage and tool call stats in one call |

## Getting started

### 1. Install

Download the latest `.vsix` from the [**newest main build**](https://github.com/michiisai/agent-insights/releases/tag/main-latest) — every push to `main` publishes a fresh one there. Then drag it onto the Extensions view, or:

```bash
gh release download main-latest --repo michiisai/agent-insights --pattern "*.vsix"
code --install-extension agent-otel-*.vsix
```

Reload VS Code. The extension activates on startup, and the status-bar item confirms the receiver is listening.

### 2. Send it some telemetry

The receiver listens on `agentInsights.port` (default `4318`). If you change it, use the same port in every endpoint below.

On recent **VS Code Insiders** builds, this captures native **Copilot, Claude Code, and Codex** sessions. Add it to `settings.json`, reload VS Code, and start a new session—Claude and Codex do not need separate configuration:

```jsonc
{
  // Native Agent Host: Copilot, Claude Code, and Codex
  "chat.agentHost.enabled": true,
  "chat.agentHost.otel.enabled": true,
  "chat.agentHost.otel.captureContent": true,
  "chat.agentHost.otel.otlpEndpoint": "http://localhost:4318",

  // Optional but recommended: extension-side Copilot / VS Code LM telemetry
  "github.copilot.chat.otel.enabled": true,
  "github.copilot.chat.otel.captureContent": true,
  "github.copilot.chat.otel.otlpEndpoint": "http://localhost:4318"
}
```

> **Content capture may include prompts, responses, tool arguments, and file contents.** Leave it off when exporting to a shared or untrusted collector. Codex currently exports user prompts but not assistant-response text.

Other telemetry sources can send OTLP/HTTP JSON to `http://127.0.0.1:<port>`. Agent-specific analysis works best with OpenTelemetry GenAI semantic-convention attributes.

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
