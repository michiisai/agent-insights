import * as vscode from 'vscode';
import { TelemetryStore } from '@agent-insights/receiver';
import { getTraces, getTraceMatches, getSpansByTraceId, getServices, getMetricsData, getLogs, getLogServiceNames, getMetricInstruments, getMetricDetail, getSessions, getSessionMessages, getUtilityCalls } from '@agent-insights/engine';
import type { WebviewToExtension, ExtensionToWebview, TabId, MetricsData, MetricInstrument, Session, UtilityCallsData } from '@agent-insights/types';

export class AgentInsightsPanel {
  static readonly viewType   = 'agentInsights';
  static currentPanel?: AgentInsightsPanel;
  /** Notifies the host when the webview switches tabs internally (e.g. a trace
   *  link), so the activity-bar sidebar selection can follow. Wired in activate. */
  static onTabChange?: (tab: TabId) => void;

  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];
  /** True once the webview has booted and can receive messages. */
  private ready = false;
  /** A tab requested before the webview was ready; flushed on 'ready'. */
  private pendingTab?: TabId;
  /** A deeplink requested before the webview was ready; flushed on 'ready'. */
  private pendingNavigation?: Extract<ExtensionToWebview, { type: 'navigateToTrace' | 'navigateToSession' }>;
  /** Cached Home/metrics result + the store data-version it was computed at.
   *  Avoids re-running the expensive metrics scan (which blocks the single
   *  synchronous extension host thread) when the data hasn't changed. */
  private metricsCache?: { version: number; data: MetricsData };
  /** Cached OTLP metric instrument list, keyed by store data-version (the list
   *  scans all metric points, so we avoid recomputing when data is unchanged). */
  private instrumentsCache?: { version: number; sinceNano: string; data: MetricInstrument[] };
  /** Cached session list, keyed by store data-version (the grouping scans all
   *  spans, so we avoid recomputing when data is unchanged). */
  private sessionsCache?: { version: number; data: Session[] };
  /** Cached utility/LM-API calls, keyed by store data-version. */
  private utilityCallsCache?: { version: number; data: UtilityCallsData };

  private constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly store: TelemetryStore,
    private port: number,
  ) {
    this.panel = vscode.window.createWebviewPanel(
      AgentInsightsPanel.viewType,
      'Agent Insights',
      vscode.ViewColumn.One,
      {
        enableScripts:          true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.joinPath(extensionUri, 'media'),
          vscode.Uri.joinPath(extensionUri, 'dist'),
        ],
      },
    );

    this.panel.webview.html = this.buildHtml();

    this.panel.onDidDispose(
      () => this.dispose(),
      null,
      this.disposables,
    );

    this.panel.webview.onDidReceiveMessage(
      (msg: WebviewToExtension) => { this.dispatchMessage(msg); },
      null,
      this.disposables,
    );
  }

  static createOrShow(extensionUri: vscode.Uri, store: TelemetryStore, port: number): void {
    if (AgentInsightsPanel.currentPanel) {
      AgentInsightsPanel.currentPanel.panel.reveal();
      return;
    }
    AgentInsightsPanel.currentPanel = new AgentInsightsPanel(extensionUri, store, port);
  }

  refresh(): void {
    this.post({ type: 'status', connected: true, port: this.port });
  }

  /** The receiver moved to a different port (the setting changed), so tell the
   *  webview — otherwise it keeps advertising the old one in its empty states. */
  updatePort(port: number): void {
    this.port = port;
    this.refresh();
  }

  navigateToTrace(traceId: string, spanId?: string): void {
    this.panel.reveal();
    const message: ExtensionToWebview = { type: 'navigateToTrace', traceId, spanId };
    if (this.ready) {
      this.post(message);
    } else {
      this.pendingNavigation = message;
    }
  }

  navigateToSession(sessionId: string): void {
    this.panel.reveal();
    const message: ExtensionToWebview = { type: 'navigateToSession', sessionId };
    if (this.ready) {
      this.post(message);
    } else {
      this.pendingNavigation = message;
    }
  }

  /** Reveal the panel and switch it to the given top-level view. Driven by the
   *  activity-bar sidebar. If the webview hasn't booted yet (first open), the
   *  switch is queued and flushed once the webview reports 'ready'. */
  showTab(tab: TabId): void {
    this.panel.reveal();
    if (this.ready) {
      this.post({ type: 'switchTab', tab });
    } else {
      this.pendingTab = tab;
    }
  }

  private post(msg: ExtensionToWebview): void {
    this.panel.webview.postMessage(msg);
  }

  /** Wraps handleMessage so a thrown error (e.g. a bad query) reaches the
   *  webview as an { type: 'error' } message instead of vanishing into the
   *  (user-invisible) extension host console, which used to leave webview
   *  placeholders like "loading spans…" stuck forever with no feedback. */
  private dispatchMessage(msg: WebviewToExtension): void {
    this.handleMessage(msg).catch(err => {
      console.error(err);
      const message = err instanceof Error ? err.message : String(err);
      this.post({
        type: 'error',
        message,
        requestType: msg.type,
        ...('sessionId' in msg && typeof msg.sessionId === 'string' ? { sessionId: msg.sessionId } : {}),
      });
    });
  }

  private async handleMessage(msg: WebviewToExtension): Promise<void> {
    const db = this.store.getDb();
    switch (msg.type) {
      case 'ready':
        this.ready = true;
        this.post({ type: 'status', connected: true, port: this.port });
        if (this.pendingTab) {
          this.post({ type: 'switchTab', tab: this.pendingTab });
          this.pendingTab = undefined;
        }
        if (this.pendingNavigation) {
          this.post(this.pendingNavigation);
          this.pendingNavigation = undefined;
        }
        break;
      case 'getTraces': {
        const search = msg.search?.trim();
        // Ask for one more trace than the webview intends to show: whether that
        // extra row comes back is how we know a "show more" control is warranted,
        // without paying for a second counting query over the whole store.
        const limit = msg.limit;
        const fetched = getTraces(db, {
          nameSearch: search,
          serviceName: msg.service,
          errorsOnly: msg.errorsOnly,
          sortOrder: msg.sortOrder,
          sessionId: msg.sessionId,
          ...(limit !== undefined ? { limit: limit + 1 } : {}),
        });
        const hasMore = limit !== undefined && fetched.length > limit;
        const traces  = hasMore ? fetched.slice(0, limit) : fetched;
        // Locating matches is the expensive half of a search — several times the
        // cost of finding the traces themselves, and it scales with how many
        // traces are previewed. Running it only over the page being shown is
        // what keeps a broad term (e.g. a model name) responsive.
        const matches = search
          ? getTraceMatches(db, { search, traceIds: traces.map(t => t.traceId) })
          : undefined;
        this.post({
          type: 'traces',
          data: traces,
          matches,
          hasMore,
          seq: msg.seq,
          sessionId: msg.sessionId,
        });
        break;
      }
      case 'getServices':
        this.post({ type: 'services', data: getServices(db) });
        break;
      case 'getSessions': {
        const version = this.store.getDataVersion();
        if (!this.sessionsCache || this.sessionsCache.version !== version) {
          this.sessionsCache = { version, data: getSessions(db) };
        }
        this.post({ type: 'sessions', data: this.sessionsCache.data });
        break;
      }
      case 'getLogServices':
        this.post({ type: 'logServices', data: getLogServiceNames(db) });
        break;
      case 'getSpans':
        this.post({ type: 'spans', traceId: msg.traceId, data: getSpansByTraceId(db, msg.traceId) });
        break;
      case 'getSessionMessages':
        this.post({ type: 'sessionMessages', sessionId: msg.sessionId, data: getSessionMessages(db, msg.sessionId) ?? { sessionId: msg.sessionId, captureEnabled: false, turns: [] } });
        break;
      case 'getSessionLogs': {
        const logs = getLogs(db, { sessionId: msg.sessionId, sortOrder: 'asc', limit: 501 });
        this.post({
          type: 'sessionLogs',
          sessionId: msg.sessionId,
          data: logs.slice(0, 500),
          hasMore: logs.length > 500,
        });
        break;
      }
      case 'getMetrics': {
        const version = this.store.getDataVersion();
        if (!this.metricsCache || this.metricsCache.version !== version) {
          // Cold path: recompute and cache. This is the only place the expensive
          // scan runs; subsequent visits with unchanged data are instant.
          this.metricsCache = { version, data: getMetricsData(db) };
        }
        this.post({ type: 'metrics', data: this.metricsCache.data });
        break;
      }
      case 'getUtilityCalls': {
        const version = this.store.getDataVersion();
        if (!this.utilityCallsCache || this.utilityCallsCache.version !== version) {
          this.utilityCallsCache = { version, data: getUtilityCalls(db) };
        }
        this.post({ type: 'utilityCalls', data: this.utilityCallsCache.data });
        break;
      }
      case 'getMetricInstruments': {
        const version   = this.store.getDataVersion();
        const sinceNano = msg.sinceNano ?? '';
        if (!this.instrumentsCache
            || this.instrumentsCache.version !== version
            || this.instrumentsCache.sinceNano !== sinceNano) {
          this.instrumentsCache = { version, sinceNano, data: getMetricInstruments(db, sinceNano || undefined) };
        }
        this.post({ type: 'metricInstruments', data: this.instrumentsCache.data });
        break;
      }
      case 'getMetricDetail':
        this.post({ type: 'metricDetail', data: getMetricDetail(db, msg.name, msg.serviceName, msg.sinceNano) });
        break;
      case 'getLogs':
        this.post({
          type: 'logs',
          data: getLogs(db, {
            filter:      msg.filter,
            excludes:    msg.excludes,
            minSeverity: msg.minSeverity,
            sinceNano:   msg.sinceNano,
            untilNano:   msg.untilNano,
            serviceName: msg.serviceName,
            sortOrder:   msg.sortOrder,
          }),
          seq: msg.seq,
        });
        break;
      case 'clearData': {
        const answer = await vscode.window.showWarningMessage(
          'Clear all stored telemetry data? This cannot be undone.',
          { modal: true },
          'Clear',
        );
        if (answer === 'Clear') {
          this.store.clear();
          this.post({ type: 'cleared' });
        }
        break;
      }
      case 'tabChanged':
        AgentInsightsPanel.onTabChange?.(msg.tab);
        break;
      case 'addItemsToChat': {
        const formatted = formatItemsForChat(msg.traces, msg.spans, msg.sessions ?? []);
        try {
          await vscode.commands.executeCommand('workbench.action.chat.open', {
            query: formatted || ' ',
            isPartialQuery: true,
          });
        } catch {
          if (formatted) {
            await vscode.env.clipboard.writeText(formatted);
            vscode.window.showInformationMessage('Copied to clipboard — paste into chat');
          }
        }
        break;
      }
    }
  }

  private buildHtml(): string {
    const wv        = this.panel.webview;
    const scriptUri = wv.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'webview.js'));
    const styleUri  = wv.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'style.css'));
    const codiconUri = wv.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'dist', 'codicon.css'));
    const nonce     = getNonce();

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy"
        content="default-src 'none';
                 style-src ${wv.cspSource} 'unsafe-inline';
                 script-src 'nonce-${nonce}';
                 font-src ${wv.cspSource};
                 img-src data:;">
  <link href="${codiconUri}" rel="stylesheet">
  <link href="${styleUri}" rel="stylesheet">
  <title>Agent Insights</title>
</head>
<body>
<div id="app">

  <header class="toolbar">
    <div class="toolbar-title">Agent Insights</div>
    <div class="toolbar-right">
      <span id="status-badge" class="badge">connecting…</span>
      <span class="toolbar-btn-group">
        <button id="refresh-btn" class="icon-btn refresh-btn" title="Refresh data" aria-live="polite">
          <span class="refresh-btn-icon" aria-hidden="true">↻</span>
          <span class="refresh-btn-label">Refresh</span>
        </button>
        <button id="clear-btn"   class="icon-btn icon-btn--danger" title="Clear all stored telemetry">✕ Clear</button>
      </span>
    </div>
  </header>

  <!-- Home tab (span-derived analytics; formerly "Performance") -->
  <div id="home-panel" class="panel active" role="tabpanel">
    <div class="metrics-grid">

      <section class="card">
        <h3 class="card-title">Summary</h3>
        <div id="summary"></div>
      </section>

      <section class="card">
        <h3 class="card-title">Token Usage</h3>
        <div id="token-usage"></div>
      </section>

      <section class="card">
        <h3 class="card-title">Latency</h3>
        <div id="slowest-ops"></div>
      </section>

      <section class="card">
        <h3 class="card-title">Tool Calls</h3>
        <div id="tool-calls"></div>
      </section>

      <section class="card card--wide">
        <h3 class="card-title">Background LM Calls</h3>
        <div id="utility-calls"></div>
      </section>

    </div>
  </div>

  <!-- Sessions tab — agent conversations grouped from traces (#15) -->
  <div id="sessions-panel" class="panel" role="tabpanel">

    <!-- Master: session list -->
    <div id="sessions-list-view" class="sessions-view">
      <div class="chat-selection-panel chat-selection-panel--empty">
        <div class="chat-selection-header">
          <span class="chat-selection-count">Chat Context (0)</span>
          <button class="chat-selection-clear-btn" title="Remove everything from chat context">Clear</button>
        </div>
        <div class="chat-selection-list">
          <span class="chat-selection-empty">No sessions, traces or spans in chat context.</span>
        </div>
      </div>
      <div id="sessions-list" class="list-container">
        <div class="empty-state">Loading sessions…</div>
      </div>
    </div>

    <!-- Detail: a single session's explorer -->
    <div id="session-detail-view" class="sessions-view" style="display:none">
      <button id="session-back-btn" class="session-back-btn" title="Back to all sessions">← Back to sessions</button>
      <div id="session-summary" class="session-summary"></div>
      <div class="traces-split session-split">
        <div class="traces-left">
          <div class="traces-sticky">
            <div class="session-traces-header">Traces</div>
            <div class="traces-filters session-traces-filters">
              <input id="session-trace-search" type="text" placeholder="Search traces…" />
            </div>
          </div>
          <div id="session-traces-list" class="list-container">
            <div class="empty-state">Loading traces…</div>
          </div>
          <section id="session-logs-section" class="session-logs-section">
            <div class="session-logs-header">
              <span class="session-logs-title">Correlated logs</span>
              <span id="session-logs-count" class="session-logs-count">Loading…</span>
            </div>
            <div class="session-logs-body">
              <div id="session-logs-list" class="session-logs-list" aria-busy="true"></div>
            </div>
          </section>
        </div>
        <div class="traces-divider" id="session-divider" aria-hidden="true"></div>
        <div class="traces-right" id="session-span-detail">
          <div class="span-detail-placeholder">← Select a trace to read its conversation, or select a span or log for details</div>
        </div>
      </div>
    </div>

  </div>

  <!-- Traces tab -->
  <div id="traces-panel" class="panel" role="tabpanel">
    <div class="traces-split">

      <!-- Left: trace list + waterfall -->
      <div class="traces-left">
        <div class="traces-sticky">
          <div class="traces-filters">
            <input  id="trace-search"   type="text" placeholder="Search traces…" />
            <button id="trace-errors-btn" class="filter-toggle" title="Errors only">⚠ Errors</button>
          </div>
          <div id="chat-selection-panel" class="chat-selection-panel chat-selection-panel--empty">
            <div class="chat-selection-header">
              <span id="chat-selection-count" class="chat-selection-count">Chat Context (0)</span>
              <button id="chat-selection-clear" class="chat-selection-clear-btn" title="Remove everything from chat context">Clear</button>
            </div>
            <div id="chat-selection-list" class="chat-selection-list">
              <span class="chat-selection-empty">No sessions, traces or spans in chat context.</span>
            </div>
          </div>
          <div class="traces-header" aria-hidden="true">
            <span class="expand-icon"></span>
            <span class="cell cell--name">Trace</span>
            <span class="cell cell--service">
              <button id="service-filter-btn" class="header-filter-btn" title="Filter by service">Service <span id="service-filter-icon" class="header-filter-icon">▾</span></button>
              <div id="service-filter-dropdown" class="header-filter-dropdown" style="display:none"></div>
            </span>
            <span class="cell cell--ts">
              <button id="time-sort-btn" class="header-filter-btn" title="Sort by time">Time <span id="time-sort-icon" class="header-filter-icon">↓</span></button>
            </span>
            <span class="cell cell--dur">Duration</span>
            <span class="cell cell--spans">Spans</span>
            <button class="add-to-chat-btn" style="visibility:hidden" aria-hidden="true" tabindex="-1">+ chat</button>
          </div>
        </div>
        <div id="traces-list" class="list-container">
          <div class="empty-state">Loading traces…</div>
        </div>
      </div>

      <!-- Resize divider -->
      <div class="traces-divider" id="traces-divider" title="Drag to resize"></div>

      <!-- Right: span detail panel -->
      <div class="traces-right" id="span-detail-panel">
        <div class="span-detail-placeholder">
          ← Expand a trace and click a span to view its details
        </div>
      </div>

    </div>
  </div>

  <!-- Metrics tab — OTLP metric instruments (#52) -->
  <div id="metrics-panel" class="panel" role="tabpanel">
    <div class="metrics-split">
      <!-- Left: instrument list -->
      <div class="metrics-left">
        <div class="metrics-toolbar">
          <div class="metrics-toolbar-row">
            <span class="metrics-toolbar-filter select-filter select-filter--grow">
              <span class="select-filter-label">Service</span>
              <button id="metric-service-filter-btn" class="select-filter-btn" title="Filter by service" aria-haspopup="listbox" aria-expanded="false">
                <span class="select-filter-value">All services</span>
                <span id="metric-service-filter-icon" class="select-filter-icon codicon codicon-chevron-down" aria-hidden="true"></span>
              </button>
              <div id="metric-service-filter-dropdown" class="header-filter-dropdown" style="display:none"></div>
            </span>
            <span class="metrics-toolbar-filter select-filter select-filter--fixed">
              <span class="select-filter-label">Time range</span>
              <button id="metric-range-filter-btn" class="select-filter-btn" title="Filter by time" aria-haspopup="listbox" aria-expanded="false">
                <span class="select-filter-value">All time</span>
                <span id="metric-range-filter-icon" class="select-filter-icon codicon codicon-chevron-down" aria-hidden="true"></span>
              </button>
              <div id="metric-range-filter-dropdown" class="header-filter-dropdown header-filter-dropdown--right" style="display:none"></div>
            </span>
          </div>
        </div>
        <div id="metrics-list" class="list-container">
          <div class="empty-state">Loading metrics…</div>
        </div>
      </div>

      <!-- Resize divider -->
      <div class="metrics-divider" id="metrics-divider" title="Drag to resize"></div>

      <!-- Right: metric detail -->
      <div class="metrics-right" id="metric-detail-panel">
        <div class="span-detail-placeholder">
          ← Select a metric to view its details
        </div>
      </div>
    </div>
  </div>

  <!-- Logs tab -->
  <div id="logs-panel" class="panel" role="tabpanel">
    <div class="logs-toolbar">
      <div class="log-filter-wrap">
        <input id="log-filter" type="text" placeholder="Filter (e.g. text, !exclude, before:YYYY-MM-DDTHH:MM:SS)" />
        <span class="log-filter-icon" title="Advanced filter active" id="log-filter-icon">⊘</span>
      </div>
    </div>
    <div class="logs-split">
      <!-- Left: log list -->
      <div class="logs-left">
        <div class="logs-header">
          <span class="log-ts">
            <button id="log-time-sort-btn" class="header-filter-btn" title="Sort by time">Created <span id="log-time-sort-icon" class="header-filter-icon">↓</span></button>
          </span>
          <span class="log-svc" style="position:relative;overflow:visible">
            <button id="log-service-filter-btn" class="header-filter-btn" title="Filter by service">Service <span id="log-service-filter-icon" class="header-filter-icon">▾</span></button>
            <div id="log-service-filter-dropdown" class="header-filter-dropdown" style="display:none"></div>
          </span>
          <span class="log-body-hdr">Details</span>
        </div>
        <div id="logs-list" class="list-container">
          <div class="empty-state">Loading logs…</div>
        </div>
      </div>

      <!-- Resize divider -->
      <div class="logs-divider" id="logs-divider" title="Drag to resize"></div>

      <!-- Right: log detail panel -->
      <div class="logs-right" id="log-detail-panel">
        <div class="span-detail-placeholder">
          ← Click a log entry to view its details
        </div>
      </div>
    </div>
  </div>

</div>
<script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }

  private dispose(): void {
    AgentInsightsPanel.currentPanel = undefined;
    this.panel.dispose();
    for (const d of this.disposables) { d.dispose(); }
    this.disposables.length = 0;
  }
}

function formatTraceForChat(data: Record<string, unknown>): string {
  return `#agentSpans Look at trace \`${data.traceId}\``;
}

function formatItemsForChat(
  traces: Record<string, unknown>[],
  spans: Record<string, unknown>[],
  sessions: Record<string, unknown>[] = [],
): string {
  const parts: string[] = [];
  // Sessions lead: they are the widest scope, and any traces/spans narrow within them.
  if (sessions.length) {
    const ids = sessions.map(d => `\`${d.sessionId}\``).join(', ');
    parts.push(`session${sessions.length > 1 ? 's' : ''} ${ids}`);
  }
  if (traces.length) {
    const ids = traces.map(d => `\`${d.traceId}\``).join(', ');
    parts.push(`traces ${ids}`);
  }
  if (spans.length) {
    const ids = spans.map(d => `\`${d.spanId}\` in trace \`${d.traceId}\``).join(', ');
    parts.push(`spans ${ids}`);
  }
  if (!parts.length) { return ''; }

  const refs: string[] = [];
  if (sessions.length) { refs.push('#agentSession'); }
  if (traces.length || spans.length) { refs.push('#agentSpans'); }

  // A session on its own is a whole conversation, so ask for the analysis that
  // scope deserves rather than the generic "look at this" used for raw spans.
  const instruction = sessions.length && !traces.length && !spans.length
    ? `Analyze ${parts[0]}: what the agent was asked to do, what it actually did, the outcome, and the root cause of any failure or slowdown.`
    : `Look at ${parts.join(' and ')}`;

  return `${refs.join(' ')} ${instruction}`;
}

function formatSpanForChat(data: Record<string, unknown>): string {
  return `#agentSpans Look at span \`${data.spanId}\` in trace \`${data.traceId}\``;
}

function getNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  return Array.from({ length: 32 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}
