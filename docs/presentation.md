# Agent Insights — final presentation content

Source material: `michiisai/agent-insights` @ `main`, extension `michiisai.agent-otel` v0.2.0.
Original outline: [Proposal: OTel Studio for VS Code · microsoft/vscode-internalbacklog#7829](https://github.com/microsoft/vscode-internalbacklog/issues/7829).

Structure below follows your eight sections. Each one opens with **what belongs there** and then gives
the substance. Where a requested topic maps onto more than one section, it says so.

| Your requested topic | Where it belongs |
|---|---|
| The user problem | § 2 Problem (primary), teased in § 1 Introduction |
| Why existing agent logs were insufficient | § 2 Problem — this is the *second half* of the problem, the part that justifies building rather than buying |
| The agent-host migration complication | § 2 Problem (as the twist) and § 7 Learning (as the lesson). Do **not** put it in Solution — it is a thing that happened *to* you |
| Architecture (extension, webview, database, LM tools) | § 3 Solution / Approach |
| How Copilot / Claude / Codex telemetry differs | § 3 Solution, first half — it is the *input* to the design |
| How Agent Insights normalizes those differences | § 3 Solution, second half — the actual contribution |
| Two demo scenarios | § 4 Demo |

---

## 1. Introduction

**What belongs here:** who you are, one sentence on what the thing is, and the one-line pitch. 2 slides, ~90 seconds.
Do not explain OpenTelemetry yet. Do not show architecture yet.

**The one-liner:**

> Agent Insights is a VS Code extension that collects the OpenTelemetry your coding agents already emit,
> and turns it into readable agent sessions — for you in a panel, and for your agent through language-model tools.

**The framing sentence to open with (this is your thesis, repeat it in Impact):**

> The data layer for agent observability is solved. Every serious agent — Copilot, Claude Code, Codex —
> emits OpenTelemetry today. What's missing is everything *after* you turn it on.

**Where the project came from (30 seconds, sets up § 7 Learning):** it started as a 12-week, two-stream proposal
called *OTel Studio for VS Code* — Stream 1, a local-first OTel viewer inside VS Code; Stream 2, making VS Code
itself emit cross-process OTel as the dogfood demo. The proposal assumed we'd build on an existing desktop prototype
(`otelux`) and that the headline demo would be diagnosing a perf issue in a sample app. What actually shipped is
narrower in one axis and much deeper in another, and the *why* is the most interesting part of the talk. Flag this
now, pay it off in Learning.

**Optional cold open** if you want a hook before any slides: the status bar. `$(broadcast) ↓12.4K 42% cached ↑3.1K`.
"That's what my agents cost me today. Nobody had to build me a dashboard — that number came out of telemetry the
agents were already emitting into the void."

---

## 2. Problem

**What belongs here:** three beats, in this order. The user problem → why the logs that exist don't solve it →
the agent-host complication that made it harder mid-project. 4–5 slides. This is the section that earns the rest of the talk.

### 2a. The user problem

You run coding agents all day. You cannot answer basic questions about them:

- **"What did I even ask it to do?"** — you ran six sessions this morning across two harnesses. Which one was the one that worked?
- **"Why did that take four minutes?"** — was it the model, a slow tool call, a permission prompt you didn't notice, or a retry loop?
- **"Why did it go wrong?"** — not *that* it failed. Agents rarely hard-fail. They quietly misunderstand, pick a wrong
  assumption on turn 2, and spend eight turns building on it. The failure is *semantic*, and it is invisible in any
  metric you'd normally collect.
- **"What is this costing me?"** — tokens are the unit of cost, and they're spread across models, cache reads,
  cache writes, subagents, and background "utility" model calls you never asked for.
- **"Is Claude actually better than Copilot at this?"** — you have a gut feeling and zero evidence.

The sharpest framing: **an agent session is the most expensive thing a developer runs all day, and it is the least
observable thing on their machine.** You can profile a 200 ms function call. You cannot profile the 4-minute,
$0.40, 14-tool-call conversation that just rewrote your auth layer.

And the loop that *should* exist doesn't: the agent sitting in your editor, which is very good at reading structured
data and explaining causality, has no access to its own history. It cannot answer "why was I slow" about itself.

### 2b. Why existing agent logs were insufficient

This is the beat that justifies building. Make it concrete — every claim below is something the codebase had to work around.

**1. The logs are per-harness, and each one is a different shape.** There is no "agent log" format. Claude Code
writes JSONL transcripts. Codex has its own session files. Copilot has chat history in the workbench. Three formats,
three storage locations, three vocabularies, zero joins. Answering "compare my Claude session to my Copilot session"
means writing three parsers and hoping the concepts line up. They don't.

**2. They're append-only text, not a queryable model.** A transcript tells you what was said. It does not tell you
that the third tool call took 41 seconds, or that turn 5 spent 90 % of its input tokens on cache reads, or that two
of the "12 tool calls" were retries of the same failed call. Duration, causality, and parent/child structure are
exactly what you need and exactly what a log file throws away.

**3. OTel exists, and that's the point — but nothing consumes it.** All three harnesses can emit OpenTelemetry.
That's the whole premise of the proposal: the *data layer is solved*. But the moment you enable it you need an
endpoint, and the options are (a) stand up a real collector plus Jaeger/Grafana — heavyweight, off-machine,
privacy-hostile for content that includes your prompts and your source code; or (b) nothing. And even if you do
stand up Jaeger, what you get is a generic span waterfall. Jaeger has never heard of a "turn". It will happily show
you 261 traces and not one of them is labelled "the conversation where I asked it to fix the flaky test".

**4. Generic OTel viewers show spans; humans think in conversations.** This is the crux. The unit of the user's
mental model is the *session* — "the thing I asked for, and what happened". The unit OTel gives you is the *span*.
A single Codex model call is **five nested spans deep**
(`run_sampling_request` → `try_run_sampling_request` → `stream_request` → `model_client.stream_responses_api` →
`responses.stream_request`). A generic viewer shows you five rows and calls it five operations. The gap between
"span" and "turn" is the entire product.

**5. Nobody agrees on the attribute names.** Not a nitpick — a hard blocker on any aggregate question. Input tokens
are `gen_ai.usage.input_tokens` (OTel semconv, agent host), *or* `llm.usage.prompt_tokens`, *or* a bare
`input_tokens` (Claude Code). Model is `gen_ai.request.model` *or* `gen_ai.response.model` *or* `llm.model` *or*
`model`. Ask a generic viewer "how many tokens today" and it answers with whichever third of your data happened to
use the key it knows.

**6. Some of the content isn't in the traces at all.** Claude Code puts the user's prompt on a *span attribute* and
the assistant's reply in an *OTel log record*. Codex reports content **only** as log records and only one side of it:
it exports `codex.user_prompt` and `codex.tool_result`, but the model's own words are streamed as `codex.sse_event`
with the payload stripped — **Codex never exports assistant response text.** A tool that reads traces sees half a
conversation. A tool that reads logs sees a different half.

### 2c. The agent-host migration complication

**Frame it honestly:** this is what happens when you build a tool on top of a platform that is itself being built.
It's the most credible thing in the talk — don't hide it.

Mid-project, VS Code shipped **Agent Host** (`chat.agentHost.*`): Claude Code, Codex, and Copilot CLI now run
*natively inside VS Code* rather than as separate processes you point at a collector. The host emits its own
telemetry, and critically it emits a `vscode.agent_host.session` **anchor span carrying W3C parent context and
`gen_ai.conversation.id` onto the provider's own trace** (microsoft/vscode#328529). That sounds like it solves
session identity for free. It creates four new problems instead:

1. **The host relabels every session.** Host spans land on the provider's trace, so a naive
   `MAX(service_name)` per session returns `vscode-agent-host` — because it sorts *after* `claude-code`,
   `codex-app-server`, and `github-copilot` alphabetically. Every native session silently becomes "the agent host".
   Fix: `AGENT_SPAN_COUNT` and `AGENT_SERVICE_NAME` explicitly exclude host spans
   (`service_name = AGENT_HOST_SERVICE_NAME OR name LIKE 'vscode.agent_host.%'`), so span counts and service labels
   describe the *agent*, not its container.
2. **The service name isn't the agent's name.** The host launches a plugin it calls `claude` / `codex` / `copilotcli`;
   each agent independently names *itself* in OTel resource attributes as `claude-code` / `codex-app-server` /
   `github-copilot`. The host doesn't control what resource name an agent picks. So the agent badge is derived from
   the **URI scheme of `vscode.agent_host.session.uri`** (`claude:/…` → Claude), not from `service_name`.
3. **The anchor only anchors the trace that *started* the thread.** Later turns in the same conversation carry no
   conversation id at all. And on Codex, whole traces say nothing — which forced a separate `codex_trace_sessions`
   projection that seeds a session alias per trace from Codex's own `conversation.id` log records, then *promotes*
   the whole conversation to the host's session id once any one trace turns out to be anchored, so arrival order
   stops mattering.
4. **A conversation id is not evidence of a conversation.** The host mints a conversation id when a chat is
   *created*, not when it is first used. Open a Codex thread and never type into it: you get a keyed "session" with
   ~37 spans of startup. Combined with a `trace_id` fallback minting one session per housekeeping trace,
   **one day of use produced 261 phantom sessions burying the 6 real ones.** The fix is a
   `BACKGROUND_TRACE_FILTER`: keep a session only if it shows real agent activity, a captured user prompt, or a
   title the host gave it.

There is also a mundane version of the same complication worth one line: the host and Copilot are configured by
**different settings** (`chat.agentHost.otel.*` vs `github.copilot.chat.otel.*`), Copilot emits traces from one and
metrics/logs from another, and if the configured endpoint port drifts from the port the receiver actually bound,
telemetry silently vanishes. That's why the extension detects the mismatch and *offers* to fix it rather than editing
your settings behind your back.

**The one-sentence takeaway for the slide:** *the platform moving under me didn't invalidate the project — it moved
the hard part from "collect the data" to "decide what the data means".*

---

## 3. Solution / Approach

**What belongs here:** first the input (how the three harnesses differ), then the design (architecture),
then the contribution (normalization). 6–8 slides. Resist starting with the box diagram — start with the mess.

### 3a. How Copilot, Claude, and Codex telemetry differs

Use one table. It is the single most persuasive slide in the deck, because every row is a thing that *had* to be
handled or the number on screen would be wrong.

| | **Copilot** | **Claude Code** | **Codex** |
|---|---|---|---|
| Service name | `github-copilot` | `claude-code` | `codex-app-server` |
| One model call = | `chat …` span | `…llm_request…` span | **5 nested spans**, only the outermost counted (`run_sampling_request`) |
| One tool call = | `execute_tool%` | `claude_code.tool` (children `.execution` / `.blocked_on_user` deliberately *excluded*) | `handle_tool_call` |
| Token attributes | `gen_ai.usage.*` / `llm.usage.prompt_tokens` | bare `input_tokens` | in a `response.completed` **log** record |
| Cache tokens | subset of input | **additive**, not a subset (Anthropic) | — |
| User prompt | span attribute (`<userRequest>` envelope) | `user_prompt` attribute on `claude_code.interaction` | `codex.user_prompt` **log record** |
| Assistant text | span attribute | **OTel log record** (`assistant_response`), stamped with the span id | **never exported** (`codex.sse_event`, payload stripped) |
| Session identity | `copilot_chat.chat_session_id` | `gen_ai.conversation.id` / `session.id` | often *nothing* — recovered via `conversation.id` log records |
| Subagents | nested `invoke_agent <name>` span | `agent_id` / `subagent_type` attributes | **none — Codex delegates to nothing** |
| Timestamps | fine | fine | `timeUnixNano: "0"`, real clock in `observedTimeUnixNano` |
| Log body | `body` | `body` | `body` unset; message is in `event.name` |

Three lines of narration that land this slide:

- *Counting a tool call is not obvious.* On Claude, matching the whole subtree **trebles** the count; matching only
  `.execution` silently **drops every permission-denied call** — the exact calls you most want to see.
- *Counting a model call is not obvious.* On Codex, five spans report the same call, all with the same count.
- *Reading a conversation is not obvious.* Two of the three harnesses split the two sides of the conversation
  across two different OTel signals, and one of them never sends the model's half at all.

### 3b. Architecture

Four npm workspace packages — the split matters because it's what keeps the SQL out of the UI and the UI out of the agent.

```
      Copilot          Claude Code          Codex          (+ VS Code Agent Host)
         │                   │                 │
         └───────── OTLP/HTTP JSON ────────────┘
                             ▼
      ┌────────────────────────────────────────────────────┐
      │ @agent-insights/receiver   127.0.0.1:4318          │
      │   /v1/traces · /v1/metrics · /v1/logs              │
      │   /.well-known/agent-insights  ← peer identity     │
      │   parser: OTLP envelope → 1 row per span/point/log │
      └────────────────────────┬───────────────────────────┘
                               ▼   (worker_threads boundary)
      ┌────────────────────────────────────────────────────┐
      │ sql.js (WASM SQLite) — raw JSON + derived columns   │
      │ projections: session_titles · codex_trace_sessions  │
      │              token_facts   (outlive retention)      │
      └────────────────────────┬───────────────────────────┘
                               ▼
      ┌────────────────────────────────────────────────────┐
      │ @agent-insights/engine — the normalization layer    │
      │ sessions · traces · metrics · logs · tokenUsage     │
      └───────┬─────────────────────────────────┬──────────┘
              ▼                                 ▼
      Webview panel (humans)          12 LM tools + skill (agents)
      Home·Sessions·Traces·           #agentSession #agentTranscript …
      Metrics·Logs                    → deeplinks back into the panel
```

**Receiver.** A plain Node HTTP server bound to loopback only. Accepts OTLP/HTTP JSON on the three signal paths.
The parser flattens envelopes to one row per entity and **preserves original values exactly** — an OTLP `intValue`
stays a string, so 64-bit token counts don't lose precision through a JS number.

There is one non-obvious endpoint: `/.well-known/agent-insights` returns
`{service, protocolVersion, instanceId, state}`. That exists because **a port can only be owned by one VS Code window**,
and developers run five. The `CollectorCoordinator` handles it: try to bind → on `EADDRINUSE`, probe the occupant
three times 100 ms apart → if it's a peer Agent Insights collector, *follow* it (read-only, 2 s heartbeat) → after two
consecutive failed heartbeats, wait a random ≤750 ms jitter and attempt takeover → if it's someone else's collector
entirely, say so instead of failing silently. Handover is clean because the outgoing owner drains
(`beginDrain()` → 503 + retry-after → `waitForIdle()` → `relinquishPersistence()`).
Worth one slide as "the unglamorous part that makes it usable".

**Database.** sql.js — SQLite compiled to WASM — **running on a worker thread**, because a multi-second query on a
span-heavy store used to freeze the extension host and with it the whole editor. The client/worker split is a small
typed request/response protocol; the extension host never touches SQL.

The storage model is *raw-first with materialized derived columns*: each row keeps one self-contained OTLP entity as
JSON in `raw`, and every queryable field is materialized into a real column. Schema, inserts, migrations, and views
are all generated from a single `DERIVED` table so they cannot drift, with a `DERIVED_VERSION` marker per row that
drives re-derivation when the definition changes.

Three details that make good speaker notes:

- **Column order is load-bearing.** Large payload columns (`attributes`, `raw`) are declared last, because reaching
  one column past a multi-KB value means walking that value and its overflow pages first — an order of magnitude on scans.
- **`ANALYZE` is not optional.** Without stats, SQLite picked the wrong index for the parent→child hop in the
  recursive trace walk: **8.4 s vs 0.2 s** on a span-heavy store. Adding `idx_raw_spans_trace(trace_id, parent_span_id)`
  turned a ~10 s query on a 3k-span trace back into a fast one.
- **Retention is per-service, not global.** 50 000 rows / 96 MB for spans, with a **5 000-row floor per service** —
  otherwise a high-volume source (Copilot) evicts a low-volume one (Claude Code) purely for being older, which would
  quietly bias exactly the agent-comparison views the product exists to provide. Pruning also refuses to orphan a
  referenced parent span.
- **Some things must outlive their spans**, so they're projected into separate tables at insert time and exempted
  from retention: `session_titles` (so a week-old session still has its name), `codex_trace_sessions` (the Codex
  identity recovery above), and `token_facts` (9-day token history, with a recursive-CTE ancestor walk to attribute
  a model when the span itself doesn't name one).

**Webview.** A single retained-context webview panel, five tabs, ~4 500 lines of dependency-free vanilla JS with a
strict CSP (nonce'd script, no `default-src`). The extension↔webview contract is one typed message union
(`WebviewToExtension` / `ExtensionToWebview`) — every request is answered or turned into a visible `error` message,
because a thrown query error used to vanish into the extension-host console and leave "loading spans…" on screen forever.

- **Home** — totals, error rate, token usage by model with cache hit rate, latency, tool calls, and *background LM calls*
  (standalone VS Code LM API calls nothing else attributes to anyone).
- **Sessions** — the headline surface. Session list → per-session summary → turn-by-turn timeline → correlated logs →
  a **readable transcript** with prompts, responses, reasoning blocks, tool-call chips, and subagent turns marked.
- **Traces / Metrics / Logs** — the conventional OTel surfaces, kept because sometimes you really do want the waterfall.

Two webview details worth mentioning because they're product decisions, not rendering:
*shared context is hoisted* out of individual turns (the harness re-sends the same system preamble every turn; showing
it 14 times is noise), and every transcript bubble knows *which span it came from*, so you can click a sentence in the
conversation and land on the exact span that produced it.

**LM tools.** Twelve `vscode.lm` tools, `#`-referenceable in chat, plus a bundled skill so the agent picks the right
one without being named:

| Reference | Tool | What it answers |
|---|---|---|
| `#agentSummary` | `summarizeRecentActivity` | "what's going on" |
| `#agentSession` | `getSessionSummary` | outcome, timeline, tokens, tools, errors for one conversation |
| `#agentTranscript` | `getSessionMessages` | what was actually **said**, paged |
| `#agentTraces` / `#agentSpans` | `listTraces` / `getTrace` | browse and drill |
| `#agentService` | `getServiceSummary` | per-agent profile (the comparison tool) |
| `#agentErrors` / `#agentSlow` | `findRecentErrors` / `getSlowestSpans` | what broke / what's slow |
| `#agentLogs` | `searchLogs` | full-text + severity |
| `#agentMetrics` / `#agentMetric` | `listMetrics` / `getMetric` | OTLP instruments, trend, prior-window delta, dimensions |
| `#tokenAndToolUsage` | `getTokenAndToolUsage` | span-derived tokens + tool stats |

Design choices that are worth defending out loud:

- **Every tool call is guaranteed to settle.** Cancellation, a 15 s timeout, and error isolation are wrapped around
  every invocation — a hung tool surfaces to an IDE-integrated client as a dead request, so a timeout that *explains
  itself* ("try narrowing the window") beats a promise that never resolves.
- **Transcripts are paged and budgeted**, not truncated silently: 10 turns by default, 1 500 chars per turn,
  40 000-char hard ceiling, and the result *tells the model how to fetch the next page*.
- **"No content captured" is an explicit answer.** If capture was off, the tool says so and instructs the model
  **not to infer what was said** — an empty transcript otherwise reads as "the user and the model said nothing".
- **Every result carries a deeplink** (`vscode://michiisai.agent-otel/navigate?sessionId=…`), and the skill makes
  including it mandatory. That closes the loop: the agent's answer is clickable, and the click lands you in the panel
  at the exact session, trace, or span. Humans and agents are looking at the same object.
- **It works in the other direction too.** Select sessions/traces/spans in the panel, hit "+ chat", and the extension
  stages a pre-built query with the right `#` reference into the chat input.

### 3c. How Agent Insights normalizes the differences

This is the contribution. Everything above is plumbing; this slide is the thesis. The pattern is the same each time:
**define the concept once, in SQL, from what the data actually shows — not from which harness sent it.**

**1. Session identity — a `COALESCE` ladder, most-trusted first.**

```sql
COALESCE(
  MAX(json_extract(attributes,'$."gen_ai.conversation.id"')),        -- OTel semconv / agent host
  MAX(json_extract(attributes,'$."session.id"')),                    -- Claude
  MAX(json_extract(attributes,'$."copilot_chat.chat_session_id"')),  -- Copilot
  (SELECT session_id FROM codex_trace_sessions WHERE trace_id = …),  -- Codex, recovered
  trace_id                                                            -- last resort
)
```
`MAX(...)` rather than a plain read, because the id is present on `chat` spans and absent on `permission` and
`execute_tool` spans in the same trace — one span knowing the answer is enough.

**2. "One model call" and "one tool call" — predicates, not names.** A single `LLM_PREDICATE` and `TOOL_PREDICATE`
that each match exactly one span per real call per harness. That's what makes any cross-agent number honest.

**3. Tokens — a `COALESCE` chain per quantity, plus accounting rules.** Input, output, cache-read and cache-creation
each collapse three or four vendor spellings into one number. Cache tokens are excluded from input where they're a
subset and *added* where they're additive (Anthropic). Where a span carries usage but no model name, a recursive-CTE
ancestor walk (depth ≤ 64) finds the nearest ancestor that names one.

**4. The agent's identity comes from the host's URI scheme**, not its service name (see § 2c).

**5. Real sessions vs. artefacts.** `BACKGROUND_TRACE_FILTER` keeps a session only if it shows agent activity, a
captured user prompt, or a host-assigned title — 261 phantom sessions → the 6 real ones. `ECHO_TRACE` drops Codex's
duplicate logging of host-executed tool calls, and it's written from **what a trace shows** (captured content, no
prompt, no round trip, no model-call span) rather than from which harness emitted it — so it doesn't rot the moment a
harness changes.

**6. Transcripts — three sources, one shape.** `getSessionMessages` resolves in order: span-attribute content
(richest) → `claudeLogTurns()` (rebuilds turns from Claude's log stream, delimiting calls by `api_request` records
that are logged when the round trip *finishes*, so a record can arrive before the call it closes) → `codexLogTurns()`
(user prompts and tool results from log records; token counts joined by **conversation id**, because Codex's
`response.completed` records carry no trace id at all — joining by trace matched nothing and no Codex transcript
ever reported a single token). All three are reshaped into the same `SessionMessageTurn`, **so no renderer and no LM
tool knows which harness it's looking at.** That's the whole idea in one sentence.

**7. Prompts are cleaned before they're shown.** `<system-reminder>` blocks, injected repository context, and
Copilot's `<userRequest>` envelope are stripped, because a 120-character prompt label whose first 66 characters are
an injected `<current_datetime>` stamp is not a label.

**8. Subagent turns are marked** — via `agent_id`/`subagent_type` on Claude, via the enclosing `invoke_agent <name>`
span on Copilot (the parent is required, because Copilot's utility LM callers carry an agent name on the chat span
itself), and not at all on Codex, which delegates to nothing.

---

## 4. Demo

**What belongs here:** two scenarios, each ≤ 3 minutes, each ending on the loop closing. Rehearse with **pre-captured
data in the store** — do not generate telemetry live on stage.

### Demo 1 — "Why did that session go wrong?" (the semantic-failure demo)

*This is your strongest demo because no existing tool can do it at all.*

1. Open the **Sessions** tab. A handful of sessions, each with the agent badge (Claude / Copilot CLI / Codex), a
   title, an outcome, turn count, tool count, tokens, duration. **Say the quiet part:** every row here was assembled
   out of spans that never contained the word "session".
2. Open a session that ran long. Read the **turn-by-turn timeline** — turn 5 is where duration and tokens spike.
3. Click into turn 5's **transcript**: the user prompt, the model's reasoning, the tool calls it made, the tool
   result it got. The failure is visible in words — a misread requirement, an assumption carried forward, the same
   approach retried.
4. Click a bubble → it jumps to **the exact span** that produced that message. Waterfall, timings, attributes.
   *Conversation and trace are the same object viewed two ways.*
5. Now hit **"+ chat"** on the session. The chat input is pre-staged with `#agentSession`. Send it. The agent reads
   its own telemetry through the LM tools and explains what happened — **with deeplinks back into the panel**, which
   the skill makes mandatory. Click one; you land back on the session.

**The line to close on:** *the agent just diagnosed the agent, and its answer is clickable.* That's the loop the
original proposal asked for, running on real agent sessions rather than a sample app.

### Demo 2 — "Which agent should I have used?" (the normalization payoff)

*This demo's value is that it looks boring and is technically the hardest thing in the project.*

1. Start on the **status bar**: `↓12.4K 42% cached ↑3.1K`. Today's tokens, at a glance, with cache hit rate.
   One click opens the panel.
2. **Home** tab: token usage by model, cache read vs cache write, tool calls with error rates, latency, and
   *Background LM Calls* — the utility-model traffic nobody attributes to anyone. Mention `agentInsights.utilityModels`
   filtering, so a `4o` completion helper doesn't pollute your "which model am I using" chart.
3. Show three sessions of **the same task on three harnesses**, side by side. Then say the thing:
   > These three rows are comparable. Getting them to be comparable is 90 % of this project. Codex reports one model
   > call as five nested spans. Claude puts the reply in a log record. All three spell "input tokens" differently.
   > Everything you're looking at is one definition applied to three vocabularies.
4. In chat, ask the comparison question. The skill routes it to `#agentService` per agent — and the skill *also*
   instructs the model to state that tool and LLM call counts are not like-for-like across harnesses rather than
   ranking them. **Show that honesty on screen**; a tool that knows the limits of its own numbers is more credible
   than one that doesn't.
5. Optional 20-second kicker: open a second VS Code window. It detects the collector, follows it read-only, and keeps
   showing data. Close the first window; the second takes over the port. No data loss, no configuration.

**Backup if a demo dies:** the Traces tab on pre-captured data, or the `#agentTranscript` tool answering in chat —
either survives without a live agent run.

---

## 5. Impact

**What belongs here:** what is *true now* that wasn't before. Claims only, no re-explaining. 1–2 slides.

- **Agent sessions are a first-class, queryable object on the developer's machine** — across three harnesses, with
  one definition of a turn, a model call, a tool call, and a token.
- **Semantic failures are diagnosable.** "It misunderstood me on turn 5" is now a thing you can point at, not a
  feeling. No log file and no generic OTel viewer gets you there.
- **The agent can reason about itself.** Twelve LM tools plus a skill mean "why was that slow", "summarize my
  sessions", "compare these two runs" are answerable *by the agent in the editor*, grounded in the user's own data,
  with clickable answers.
- **Cost is visible continuously, not retrospectively** — a live status-bar baseline out of telemetry that was
  otherwise being thrown away.
- **It's local-first and private by construction.** Loopback-only receiver, on-disk SQLite in extension storage,
  nothing leaves the machine. That matters precisely *because* the interesting data is prompts, responses, tool
  arguments, and source code — which is also why content capture is opt-in and documented as such
  (see `docs/threat-model.md`).
- **It survives real use.** Multi-window collector handover, byte- and row-bounded retention with per-service floors,
  projections that outlive retention, a worker thread so a heavy query can't freeze the editor.
- **Against the proposal's own bar:** *"a developer can investigate any agent run from inside VS Code without leaving
  the editor"* and *"Copilot Chat can answer 'why did this fail / why was it slow / summarize my sessions' grounded in
  the user's own OTel data"* — both met, on live multi-harness agent data.

---

## 6. Next steps

**What belongs here:** honest, specific, ranked. Include the things you know are missing — it reads as command of
the problem, not as apology. 1 slide.

- **Codex assistant text.** Codex exports user prompts but not response text; the transcript is half-blind on one of
  three harnesses. This is an upstream ask, and worth raising as one.
- **Stream 2 from the proposal — VS Code's own cross-process OTel** (`IOTelService` across renderer / ext host / AHP,
  per microsoft/vscode#316090). Never started here; the agent-host work overtook it. It's still the natural next
  surface, and the extension is already the consumer it needs.
- **Cost, not just tokens.** Token counts come from spans, not from provider billing. Per-model pricing would turn
  the status bar from a usage baseline into a spend baseline.
- **Session diffing as a first-class view** — "same prompt, two agents" or "before and after my prompt change",
  currently something you assemble by reading two summaries.
- **Longer-horizon history.** `token_facts` already survives pruning for 9 days; the same projection pattern could
  give weeks of trend data without keeping weeks of spans.
- **In-core install nudges** at the four moments the proposal identified (a failed run, a slow or token-heavy run, a
  session-summary request, prompting help). Needs a core change, but the extension side is ready.
- **Marketplace publish** — packaged (`agent-otel-0.2.0.vsix`), not published.

---

## 7. Learning

**What belongs here:** what you'd tell someone starting this project. Concrete beats profound. 1–2 slides.
This is where the agent-host complication pays off as a *lesson*.

1. **Build for what the data shows, not for who sent it.** Every filter written as "if it's Codex, do X" would have
   rotted within a release. `ECHO_TRACE` is defined by *shape* — has content, no prompt, no round trip, no model-call
   span — and that's why it still holds. Harness-specific code is a dated cheque.

2. **A platform moving under you changes which problem you're solving.** The agent host arrived mid-project and made
   collection *easier* and interpretation *harder*. The lesson isn't "platforms are unstable" — it's that the moment
   the plumbing gets solved for you, the remaining value moves up a layer, into semantics. Plan to be there.

3. **The hard part was never the pipeline.** The receiver is ~200 lines. The normalization layer is ~2 600.
   That ratio *is* the finding: OTel collection is commodity; making three vendors' emissions mean the same thing is not.

4. **Deviating from the plan was correct, and I can say why.** The proposal assumed building on the `otelux` prototype
   and a two-stream scope with a sample-app perf demo. This was built ground-up, single-stream, and re-aimed at agent
   sessions rather than app traces. That happened because the agent host made *agents* the most interesting OTel
   emitter on the machine — the demo the proposal put second turned out to be the whole product. Scope that shrank on
   one axis went much deeper on another.

5. **Measure before optimizing, then measure the optimizer.** `ANALYZE` was an 8.4 s → 0.2 s difference and it is one
   statement. Column order in a SQLite table was an order of magnitude on scans. Neither was where I'd have guessed.

6. **Blocking the extension host is a product bug, not a perf bug.** A slow query froze the whole editor. Moving the
   database onto a worker thread was the single change that made the extension feel like a real one.

7. **Silence is the worst failure mode.** A port mismatch dropped every span with no error anywhere. A thrown query
   error vanished into a console the user never sees and left "loading spans…" on screen forever. Both fixes were
   about making failure *visible*, and both mattered more than any feature.

8. **Design for the agent as a first-class consumer.** Writing tool output for an LLM is its own discipline: page and
   budget instead of truncating, say "content capture was off — do **not** infer what was said" instead of returning
   an empty list, and make deeplinks mandatory so an answer stays connected to the thing it describes.

---

## 8. Acknowledgement

**What belongs here:** short, specific, sincere. 1 slide, 30 seconds. Name people, then the shoulders you stood on.

- **@zhichli** — author of the original *OTel Studio for VS Code* proposal and the `otelux` prototype that framed the
  problem space, and co-assignee on the issue.
- **@karthiknadig** and **@kieferrm** — cc'd on the proposal / early direction.
- The **VS Code agent-host team** — for microsoft/vscode#328529 (the session anchor span) and the `chat.agentHost.otel.*`
  surface this is built on, and for microsoft/vscode#316090, which is what makes Stream 2 a real next step rather than
  an idea.
- The **OpenTelemetry GenAI semantic conventions** working group — `gen_ai.*` is the only reason a shared vocabulary
  exists to normalize *toward*.
- The **Copilot, Claude Code, and Codex** teams — for emitting telemetry at all. Every difference in the table in
  § 3a exists because three teams each independently decided this was worth instrumenting.
- Anyone who dogfooded it and reported that their session list had 261 rows in it.

---

## Appendix — numbers worth having on a slide or in your pocket

| Fact | Value |
|---|---|
| Phantom vs real sessions, one day of use | 261 vs 6 |
| Codex spans per single model call | 5 (nested) |
| `ANALYZE` on the recursive trace walk | 8.4 s → 0.2 s |
| `idx_raw_spans_trace` on a 3k-span trace | ~10 s → fast |
| Retention caps | 50 000 rows; 96 MB spans / 32 MB metrics & logs |
| Per-service row floor | 5 000 |
| `token_facts` retention | 9 days (survives span pruning) |
| LM tools | 12, plus 1 bundled skill |
| LM tool timeout | 15 s, always settles |
| Transcript budget | 10 turns / 1 500 chars per turn / 40 000 char ceiling |
| Collector heartbeat / takeover | 2 s, 2 failures, ≤750 ms jitter |
| Default port | 4318 (`agentInsights.port`) |
| Normalization layer vs receiver | ~2 600 lines vs ~200 |

**Setup block for a backup slide:**

```jsonc
{
  "chat.agentHost.enabled": true,
  "chat.agentHost.otel.enabled": true,
  "chat.agentHost.otel.captureContent": true,
  "chat.agentHost.otel.otlpEndpoint": "http://localhost:4318",
  "github.copilot.chat.otel.enabled": true,
  "github.copilot.chat.otel.captureContent": true,
  "github.copilot.chat.otel.otlpEndpoint": "http://localhost:4318"
}
```
