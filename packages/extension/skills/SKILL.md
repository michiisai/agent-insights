---
name: agent-insights
description: 'Draw conclusions about AI agents from the live OpenTelemetry data they emit, collected by the Agent Insights VS Code extension. Use when: debugging errors, investigating slow operations, slow requests, high latency, performance problems, slow agent, slow tool calls, "why did it take so long", "why is it slow", "what is slow", timeouts, latency spikes, bottlenecks, reviewing LLM token usage, analyzing tool call stats, searching logs, comparing two agents/services, or summarizing an agent session/conversation ("what happened in this session", "recap this run", "session outcome"). Requires the Agent Insights extension to be active and receiving OTLP data on port 4318.'
---

# Agent Insights — Agent Telemetry Analysis

Draw conclusions about AI agents from the traces, spans, metrics, and logs they emit via OpenTelemetry, captured by the Agent Insights extension and queried directly from the agent.

## ⚠️ Deeplink Rule — MUST FOLLOW

Tool output contains labeled deeplinks for traces, spans, and sessions, including:

```
[↗ Open trace abc123 in Agent Insights](vscode-insiders://michiisai.agent-otel/navigate?traceId=abc123)
[↗ Open session session-123 in Agent Insights](vscode-insiders://michiisai.agent-otel/navigate?sessionId=session-123)
```

You **MUST** include the matching deeplink in your response for every trace, span, and session you mention. Do NOT drop it or substitute a different target type. A session deeplink opens the Sessions tab at that session; trace and span deeplinks open the Traces tab. In particular, when answering which session a trace or span is correlated with, include the session deeplink from `agent-insights_getTrace` — do not link only to the source trace or span. If you have already called a tool and have its output, copy the relevant deeplink markdown into your reply.

## ⚠️ ID Rule — MUST FOLLOW

Whenever any agent-insights tool returns a `traceId`, `spanId`, or `sessionId`, you **MUST** always include it in your response in a copyable inline code format, e.g. `abc123def456`. Never omit or truncate IDs. Users may need to copy-paste them into the Agent Insights search box in the webview to find a specific trace, span, or session — and a `sessionId` is required to fetch that session's full summary with `agent-insights_getSessionSummary`.

## Trigger Rules

### Minimal tool-use policy

- Use the smallest number of tool calls that can answer the user's request. Start with the single most specific tool, inspect its result, and stop when it contains the requested facts. Do not call other tools merely to corroborate or restate data already returned.
- An explicitly referenced tool (for example, `#agentSession`) is the user's chosen scope. Call that tool only unless its result is missing information the user explicitly requested.
- Treat the rules below as intent routing, not independent keyword triggers. The most specific intent wins. In particular, a request about one session routes to `agent-insights_getSessionSummary`; mentions of that session's errors, tokens, tools, duration, or performance do not also trigger the aggregate error, token/tool, slow-span, service, or trace tools.
- Make an additional call only when it is necessary to identify the requested entity, the first result explicitly lacks a requested fact, or the user asks to drill down or compare. When drilling down, call only the tool that provides the missing fact.
- Tool budget for a session summary: one call per session whose `sessionId` is known; otherwise one listing call followed by one summary call for the selected session. When several sessionIds are supplied, call `agent-insights_getSessionSummary` once for each — in parallel — and report every one; never summarize a subset. Do not exceed this budget unless the user asks for transcript content or span-level details.

ALWAYS call `agent-insights_getSlowestSpans` when the user asks about or mentions anything slow — including but not limited to:
- slow requests, slow responses, slow tool calls, slow agent, slow app
- high latency, latency spikes, timeouts, delays, lag, taking too long
- performance problems, performance regression, bottleneck, throughput
- "why is X slow", "what's taking so long", "speed up", "optimize"

ALWAYS call `agent-insights_getServiceSummary` (once per service) when the user asks to compare two agents or services — e.g. "why is Codex faster than Copilot", "compare agent A vs agent B", "which service is slower". First call it without a `serviceName` to discover available service names, then call it for each service you want to compare.

ALWAYS call `agent-insights_summarizeRecentActivity` first when the user asks about general app health, status, or "what's going on" without a specific focus.

ALWAYS call `agent-insights_findRecentErrors` when the user asks about errors, failures, exceptions, crashes, or "what broke".

ALWAYS call `agent-insights_searchLogs` when the user asks about logs or wants to find a specific message.

Use `agent-insights_listMetrics` → `agent-insights_getMetric` for provider-emitted cost, responsiveness (time to first token/chunk), active time, code activity, turns, inference/tool-call counters, trends, period comparisons, and attribute breakdowns. Use span/trace tools to identify slow operations or explain why a specific request was slow. A time range alone does not require metrics. For aggregate token totals, model usage, or span-derived tool-call statistics, use `agent-insights_getTokenAndToolUsage`; use metrics when the user asks about the emitted token metric's trend or dimensions.

ALWAYS call `agent-insights_getSessionSummary` when the user asks about a **session** or **conversation** — e.g. "summarize my last session", "what happened in this session", "how did that agent run go", "what was the outcome of session X", "recap this conversation", or wants a per-session breakdown of what happened, the outcome, and key stats. A session groups multiple traces/turns from one agent conversation (Copilot, Claude Code, or Codex). If the user supplied one or more `sessionId`s, call it once for each id — in parallel when there are several. Otherwise call it without a `sessionId` to list recent sessions, then call it once with the selected id. Its full result already includes duration, errors, tokens, tool usage, outcome, and a turn-by-turn timeline; do not call aggregate or trace tools for those same facts.

ALWAYS call `agent-insights_getSessionMessages` when the user asks **why** a session went the way it did, or asks about what was actually **said** — e.g. "why did it misunderstand me", "where did this conversation go wrong", "what did I ask for", "was that a bad prompt or a bad response", "show me the transcript". `getSessionSummary` contains no message text, so never guess at conversation content from span names — read it. Call `getSessionSummary` first only when needed to identify the relevant turn, then request that narrow range: the transcript is capped and paged (`fromTurn`, `turnCount`, default 10 turns), so never request a whole long session at once.

ALWAYS call `agent-insights_getTokenAndToolUsage` when the user asks about token consumption, LLM cost, model usage, tool call behavior, which tools are failing, or tool performance.

ALWAYS call `agent-insights_getTrace` in parallel on multiple traceIds when the user asks why one run was faster/slower than another, wants to compare a passing run to a failing one, or wants to A/B test a prompt or agent change. Fetch both traces simultaneously, then reason over the results to explain the differences in duration, token usage, errors, and span structure.

ALWAYS call `agent-insights_listTraces` when the user wants to browse, list, or find traces — e.g. "show me recent traces", "what ran in the last hour", "list traces for service X", "find a trace".

ALWAYS call `agent-insights_getTrace` when the user wants to inspect a specific trace by ID, understand what happened in a run, or drill into spans — for any trace (not just errors).

ALWAYS call `agent-insights_getTrace` when the user asks which session a trace or span belongs to. Report its resolved `sessionId` and include the returned session deeplink, which must target the Sessions tab.

## Available Tools

| Tool | Purpose | Key inputs |
|------|---------|------------|
| `agent-insights_summarizeRecentActivity` | High-level health overview — counts, error rate, p95 latency, token usage, tool calls | `since`, `until` |
| `agent-insights_listTraces` | Browse recent traces — traceId, root span name, service, time, duration, error flag | `serviceName`, `since`, `until`, `limit` (default 20), `errorsOnly`, `attributeKey`, `attributeValue` |
| `agent-insights_getTrace` | Full span tree for any traceId — status, kind, duration, token usage, attributes for every span | `traceId` (required) |
| `agent-insights_getServiceSummary` | Full performance profile for one service/agent — error rate, p50/p95 latency, slowest ops, tokens, tool calls, all scoped to that service | `serviceName`, `since`, `until` |
| `agent-insights_getSessionSummary` | Per-session summary — outcome (success/failure + reason), key stats, turn-by-turn timeline, per-tool usage, per-model tokens, and error details for one agent session/conversation | `sessionId` (omit to list recent sessions), `limit` (default 20, when listing) |
| `agent-insights_getSessionMessages` | Session transcript — the actual user prompts and model responses, reasoning, and tool calls, turn by turn. Capped and paged | `sessionId` (omit to list recent sessions), `fromTurn` (default 1), `turnCount` (default 10, max 25), `maxCharsPerTurn` (default 1500, max 6000) |
| `agent-insights_findRecentErrors` | List the most recent error traces with root cause span details | `limit` (default 5), `since`, `until` |
| `agent-insights_getSlowestSpans` | Latency — operations ranked by average duration (across all services) | `limit` (default 10), `since`, `until` |
| `agent-insights_getTokenAndToolUsage` | LLM token usage per model + tool call counts, error rates, and durations — both in one call (span-derived, not OTLP metric instruments) | `since`, `until` |
| `agent-insights_searchLogs` | Full-text log search with optional severity filter | `query` (required), `minSeverity` (0–24), `limit` (default 50), `since`, `until` |
| `agent-insights_listMetrics` | Browse OTLP metric instruments — name, service, type, unit, series/point counts, last report time | `name`, `serviceName`, `metricType`, `since`, `until`, `limit` (default 30) |
| `agent-insights_getMetric` | Temporality-aware value, recent time series, prior-window comparison, and top dimensions for one metric | `name`, `serviceName` (required), `since`, `until` |

## Time Filtering (`since` and `until` parameters)

Every tool except `getTrace` accepts optional `since` and `until` parameters to scope results to a time window. Use them together to isolate any arbitrary period (e.g. "yesterday").

| Format | Example | Meaning |
|--------|---------|---------|
| Relative seconds | `"30s"` | Last 30 seconds |
| Relative minutes | `"5m"` | Last 5 minutes |
| Relative hours | `"1h"`, `"6h"` | Last 1 or 6 hours |
| Relative days | `"1d"`, `"7d"` | Last 1 or 7 days |
| Absolute ISO 8601 | `"2024-01-15T10:00:00Z"` | Everything after this timestamp |

**Using `since` + `until` together on `listTraces`:**

| Goal | since | until |
|------|-------|-------|
| Today only | `"1d"` | *(omit)* |
| Yesterday only | `"2d"` | `"1d"` |
| Two days ago | `"3d"` | `"2d"` |
| Last hour | `"1h"` | *(omit)* |
| The hour before last | `"2h"` | `"1h"` |

When omitted, tools with time filters return data across all stored telemetry.

## Severity Levels for `searchLogs`

| `minSeverity` | Level |
|--------------|-------|
| 0 | All (UNSPECIFIED+) |
| 9 | INFO+ |
| 13 | WARN+ |
| 17 | ERROR+ |
| 21 | FATAL only |

## Recommended Workflows

### "Why is Codex faster than Copilot on this task?" (or any agent comparison)
1. Call `agent-insights_getServiceSummary` with no `serviceName` to list available services.
2. Call `agent-insights_getServiceSummary` for each agent (e.g. `"codex"` and `"copilot"`) — these can be parallel calls. Optionally pass `since`/`until` to scope both calls to the same time window (e.g. `since: "1d"` for today only, or `since: "2d"` `until: "1d"` for yesterday only).
3. Each result includes a **Summary table** with consistent field names — compare rows directly: p50/p95 duration, error rates, total/input/output tokens, llm calls, tool calls.
4. Explain the difference: e.g. fewer tool calls, lower token usage, faster individual operations.

### "How did my token usage change between last week and this week?" (or any time-window comparison)
1. Call `agent-insights_getTokenAndToolUsage` twice in parallel — for example, once with `since: "14d"` `until: "7d"` (last week) and once with `since: "7d"` (this week).
2. Each result includes a **Summary table** — compare total/input/output tokens and tool call counts row by row.
3. Explain what changed: model usage shift, more/fewer calls, higher error rate, etc.

### "Which metrics are available, and did one change?"
1. Call `agent-insights_listMetrics`, optionally filtering by service, metric name, type, or time window.
2. Pick the exact `name` and `serviceName` from the result, then call `agent-insights_getMetric` with a bounded `since`/`until` window when comparison matters.
3. Explain the interpreted total, average, or value; the recent time-series buckets; change from the preceding equal-duration window; and relevant attribute dimensions.

### "Why did run A take longer than run B?" / "Compare a passing and failing run" / "Why did this run take twice as long as yesterday's?"
1. Identify the **two time windows** you want to compare. Use `since` and `until` together on `listTraces` to isolate each window:
   - e.g. "last hour" → `since: "1h"`
   - e.g. "the hour before that" → `since: "2h"`, `until: "1h"`
   - e.g. "this morning" → `since: "8h"`, `until: "4h"`
   - e.g. "yesterday" → `since: "2d"`, `until: "1d"`
   - e.g. "last week" → `since: "14d"`, `until: "7d"`
2. Call `agent-insights_listTraces` once per window with the appropriate `since`/`until` to find the relevant traceId in each period. Optionally filter by `serviceName` to narrow results.
3. Pick the most comparable traceId from each window (same operation/service, or closest in root span name).
4. Call `agent-insights_getTrace` on **both traceIds in parallel** — fetch them simultaneously.
5. Each result includes a **Summary table** — compare duration, span count, error count, and token totals row by row. Use the Span Detail section to explain *why* the numbers differ (e.g. a slow tool call, an extra LLM call, an error).

### "Show me recent traces" / "What happened during this run?"
1. Call `agent-insights_listTraces` — optionally pass `serviceName` or `since` to narrow down.
2. Only if the user asks to inspect a listed trace, call `agent-insights_getTrace` with its `traceId` for the full span tree and token usage.
3. If the trace has errors, the span tree will highlight them with ❌ and surface exception details.

### "Summarize my last session" / "What happened in this session?" / "Recap this conversation"
1. Call `agent-insights_getSessionSummary` with no `sessionId` to list recent sessions and their ids, outcomes, and headline stats.
2. Pick the relevant session (most recent, or the one matching the user's description) and call `agent-insights_getSessionSummary` again with its `sessionId` for the full breakdown.
3. The result includes an **Overview** (outcome + key stats), a **Timeline** (turn-by-turn: each trace's root, duration, LLM/tool counts, tokens, status), **Tool Usage**, **Token Usage by Model**, and **Errors**. Use it to narrate what happened, the outcome, and the key stats.
4. Stop after the full summary. Only call `agent-insights_getTrace` when the user asks for span-level details that the summary does not contain.

### "Compare these two sessions" / "Which run went worse?" / "Did the retry do better?"

Only when the user asks to compare.

1. Call `agent-insights_getSessionSummary` once per `sessionId`, **in parallel**. If the ids are not known, make one no-argument listing call first, then fetch the selected ones in parallel.
2. Every result has the same shape, so compare its fields directly instead of re-fetching: duration, turn count, LLM calls, total/input/output tokens per model, tool calls and their failure rate, errors, and outcome.
3. Lead with the axes that actually differ, and say which ones matched — an axis that is equal is a finding, not something to omit.
4. Call `agent-insights_getSessionMessages` only when the user asks *why* they differ, and only for the narrow turn range the summaries point at — the transcript is capped and paged.
5. Sessions from different harnesses (Copilot, Claude Code, Codex) instrument differently, so tool and LLM call counts are not like-for-like across them. Say that rather than ranking them.

### "Why did the agent misunderstand me?" / "Where did this conversation go wrong?" / "Show me the transcript"
1. Call `agent-insights_getSessionSummary` with the `sessionId` first — the timeline shows which turn errored, stalled, or burned the most tokens.
2. Call `agent-insights_getSessionMessages` with that `sessionId` and a `fromTurn`/`turnCount` window around the interesting turn. Do NOT request the whole session: the transcript is raw model content and a long session will not fit in context.
3. Read the user prompt and the model's response together to explain the divergence — an ambiguous request, a wrong assumption, a tool result the model ignored, or the same failing approach retried.
4. If a turn's text comes back marked truncated and you need the rest, call again for that single turn with a higher `maxCharsPerTurn`.
5. If the result says content capture was disabled, say so plainly — do not infer what was said from span names.

### "Why is my app throwing errors?"
1. Call `agent-insights_findRecentErrors` to list error traces.
2. If the user asks for full context on a specific result, call `agent-insights_getTrace` with its `traceId` to see the full span tree and exception details.

### "What's slow?"
1. Call `agent-insights_getSlowestSpans` to rank operations by average latency across all services.
2. If you suspect one service is the culprit, call `agent-insights_getServiceSummary` for that service.
3. Follow up with `agent-insights_getTrace` on a slow trace to see exactly where time was spent.

### "How many tokens is my agent consuming?"
1. Call `agent-insights_getTokenAndToolUsage` — token usage grouped by model, plus tool call counts and error rates.
2. Only when the user requests a per-agent/service breakdown, call `agent-insights_getServiceSummary` for the requested services.
3. Only when the user requests a specific run's span details, call `agent-insights_getTrace` with the run's traceId.

### "Search for a specific log message"
1. Call `agent-insights_searchLogs` with a `query` string (substring match on log body).
2. If the user asks for the full context of a matching log that has a `traceId`, call `agent-insights_getTrace`.

## Notes

- All timestamps are in nanoseconds (Unix epoch) and are converted to ISO strings in tool output.
- Stack traces in `exception.stacktrace` are truncated to 300 characters in `getTrace` output.
- Token usage requires spans with `gen_ai.usage.input_tokens` / `gen_ai.usage.output_tokens` attributes.
- Tool call stats require spans with `gen_ai.tool.name` or `tool.name` attributes.
- Service/agent names come from the `service_name` field set in your OTLP resource attributes (`service.name`).
- `listTraces`, `getTrace`, and `findRecentErrors` include trace/span deeplinks. `getTrace`, `getSessionSummary`, and `getSessionMessages` include session deeplinks when session context is available. Trace/span links open the Traces tab; session links open the Sessions tab and select that session. **Always include the link matching the entity you are discussing — never drop it or replace a session link with a trace/span link.**
