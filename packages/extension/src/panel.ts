import * as vscode from 'vscode';
import type { WebviewToExtension, ExtensionToWebview, TabId } from '@agent-insights/types';
import type { TelemetryDatabase } from './database/service';
import { getModelVisibility } from './modelVisibility';
import { showAgentInsightsSetup } from './settingsSetup';

export class AgentInsightsPanel {
  static readonly viewType   = 'agentInsights';
  static currentPanel?: AgentInsightsPanel;
  /** Syncs in-webview navigation with the activity bar. */
  static onTabChange?: (tab: TabId) => void;

  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];
  private disposed = false;
  private ready = false;
  private pendingTab?: TabId;
  private pendingNavigation?: Extract<ExtensionToWebview, { type: 'navigateToTrace' | 'navigateToSession' }>;
  /** Whether staged chat context is awaiting its first tool invocation. */
  private chatHandoffPending = false;

  private constructor(
    panel: vscode.WebviewPanel,
    private readonly extensionUri: vscode.Uri,
    private readonly database: TelemetryDatabase,
    private port: number,
  ) {
    this.panel = panel;
    // Restored panels do not retain their creation options.
    this.panel.webview.options = AgentInsightsPanel.webviewOptions(extensionUri);

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

    this.panel.webview.html = this.buildHtml();
  }

  private static webviewOptions(extensionUri: vscode.Uri): vscode.WebviewOptions {
    return {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(extensionUri, 'media'),
        vscode.Uri.joinPath(extensionUri, 'dist'),
      ],
    };
  }

  static createOrShow(extensionUri: vscode.Uri, database: TelemetryDatabase, port: number): void {
    if (AgentInsightsPanel.currentPanel) {
      AgentInsightsPanel.currentPanel.panel.reveal();
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      AgentInsightsPanel.viewType,
      'Agent Insights',
      vscode.ViewColumn.One,
      { ...AgentInsightsPanel.webviewOptions(extensionUri), retainContextWhenHidden: true },
    );
    AgentInsightsPanel.currentPanel = new AgentInsightsPanel(panel, extensionUri, database, port);
  }

  /** Reattach to a panel restored after a window reload. */
  static revive(
    panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri,
    database: TelemetryDatabase,
    port: number,
  ): void {
    if (AgentInsightsPanel.currentPanel) {
      panel.dispose();
      return;
    }
    AgentInsightsPanel.currentPanel = new AgentInsightsPanel(panel, extensionUri, database, port);
  }

  refresh(): void {
    this.post({ type: 'status', connected: true, port: this.port });
  }

  refreshData(): void {
    this.post({ type: 'refreshData' });
  }

  notifyChatToolInvoked(): void {
    if (!this.chatHandoffPending) { return; }
    this.chatHandoffPending = false;
    this.post({ type: 'chatSelectionConsumed' });
  }

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

  /** Reveal a top-level view, queuing it until the webview is ready. */
  showTab(tab: TabId): void {
    this.panel.reveal();
    if (this.ready) {
      this.post({ type: 'switchTab', tab });
    } else {
      this.pendingTab = tab;
    }
  }

  private post(msg: ExtensionToWebview): void {
    if (this.disposed) { return; }
    this.panel.webview.postMessage(msg);
  }

  private dispatchMessage(msg: WebviewToExtension): void {
    this.handleMessage(msg).catch(err => {
      console.error(err);
      const message = err instanceof Error ? err.message : String(err);
      this.post({
        type: 'error',
        message,
        requestType: msg.type,
        ...('sessionId' in msg && typeof msg.sessionId === 'string' ? { sessionId: msg.sessionId } : {}),
        ...('traceId' in msg && typeof msg.traceId === 'string' ? { traceId: msg.traceId } : {}),
      });
    });
  }

  private async handleMessage(msg: WebviewToExtension): Promise<void> {
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
        // Fetch one extra row to detect another page.
        const limit = msg.limit;
        const fetched = await this.database.request('getTraces', {
          nameSearch: search,
          serviceName: msg.service,
          errorsOnly: msg.errorsOnly,
          categories: msg.errorsOnly ? undefined : msg.categories,
          sortOrder: msg.sortOrder,
          sessionId: msg.sessionId,
          ...(limit !== undefined ? { limit: limit + 1 } : {}),
        });
        const hasMore = limit !== undefined && fetched.length > limit;
        const traces  = hasMore ? fetched.slice(0, limit) : fetched;
        // Build previews only for visible rows.
        const matches = search
          ? await this.database.request('getTraceMatches', {
              search,
              traceIds: traces.map(t => t.traceId),
            })
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
        this.post({ type: 'services', data: await this.database.request('getServices', undefined) });
        break;
      case 'getSessions': {
        this.post({
          type: 'sessions',
          data: await this.database.request('getSessions', {}),
        });
        break;
      }
      case 'getLogServices':
        this.post({
          type: 'logServices',
          data: await this.database.request('getLogServiceNames', undefined),
        });
        break;
      case 'getSpans': {
        const detail = await this.database.request('getTraceDetails', { traceId: msg.traceId });
        this.post({ type: 'spans', traceId: msg.traceId, data: detail.spans });
        break;
      }
      case 'getSessionMessages':
        this.post({
          type: 'sessionMessages',
          sessionId: msg.sessionId,
          data: await this.database.request('getSessionMessages', { sessionId: msg.sessionId })
            ?? { sessionId: msg.sessionId, captureEnabled: false, turns: [] },
        });
        break;
      // The webview caches this trace-scoped result.
      case 'getTraceMessages':
        this.post({
          type: 'traceMessages',
          traceId: msg.traceId,
          data: await this.database.request('getTraceMessages', { traceId: msg.traceId })
            ?? { traceId: msg.traceId, captureEnabled: false, turns: [] },
        });
        break;
      case 'getSessionLogs': {
        const logs = await this.database.request('getLogs', {
          sessionId: msg.sessionId,
          sortOrder: 'desc',
          limit: 501,
        });
        this.post({
          type: 'sessionLogs',
          sessionId: msg.sessionId,
          data: logs.slice(0, 500),
          hasMore: logs.length > 500,
        });
        break;
      }
      case 'getAgentAnalytics': {
        const visibility = getModelVisibility();
        const data = await this.database.request('getAgentAnalytics', { visibility });
        this.post({ type: 'agentAnalytics', data });
        break;
      }
      case 'getUtilityCalls': {
        const visibility = getModelVisibility();
        const data = await this.database.request('getUtilityCalls', { visibility });
        this.post({ type: 'utilityCalls', data });
        break;
      }
      case 'getMetricInstruments': {
        const data = await this.database.request('getMetricInstruments', {
          sinceNano: msg.sinceNano,
          untilNano: msg.untilNano,
        });
        this.post({ type: 'metricInstruments', data });
        break;
      }
      case 'getMetricDetail':
        this.post({
          type: 'metricDetail',
          data: await this.database.request('getMetricDetail', {
            name: msg.name,
            serviceName: msg.serviceName,
            sinceNano: msg.sinceNano,
            untilNano: msg.untilNano,
          }),
        });
        break;
      case 'getLogs':
        this.post({
          type: 'logs',
          data: await this.database.request('getLogs', {
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
      case 'openUtilityModelSettings':
        await vscode.commands.executeCommand(
          'workbench.action.openSettings',
          '@ext:michiisai.agent-otel utility',
        );
        break;
      case 'openSettingsSetup':
        await showAgentInsightsSetup();
        break;
      case 'clearData': {
        if (!this.database.isWritable) {
          vscode.window.showWarningMessage(
            'Agent Insights: this window is read-only because another window owns the OTLP port, so the data cannot be cleared from here. Use the window that is receiving telemetry.',
          );
          break;
        }
        const answer = await vscode.window.showWarningMessage(
          'Clear all stored telemetry data? This cannot be undone.',
          { modal: true },
          'Clear',
        );
        if (answer === 'Clear') {
          await this.database.clear();
          this.post({ type: 'cleared' });
        }
        break;
      }
      case 'tabChanged':
        AgentInsightsPanel.onTabChange?.(msg.tab);
        break;
      case 'addItemsToChat': {
        const formatted = formatItemsForChat(msg.traces, msg.spans, msg.sessions ?? []);
        // Ignore hand-cleared selections.
        this.chatHandoffPending = formatted.length > 0;
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
        <button id="settings-btn" class="icon-btn settings-btn" type="button" title="Open OTel settings" aria-label="Open OTel settings">
          <span class="codicon codicon-settings-gear" aria-hidden="true"></span>
        </button>
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
    <div class="analytics-grid">

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

      <section id="utility-calls-card" class="card card--wide" hidden>
        <h3 class="card-title">Background LM Calls</h3>
        <div id="utility-calls"></div>
      </section>
      <div id="utility-calls-note" class="analytics-note" hidden>
        Background LM call details appear here when standalone VS Code Language Model API calls are detected.
        Utility-model filters may hide matching calls.
        <button id="utility-settings-btn" class="analytics-note-link" type="button">Review settings</button>
      </div>
     <div
       class="analytics-scope"
       role="note"
       title="Home analytics are calculated from telemetry currently retained in the local database. Retention varies with telemetry volume, so these figures may not represent all historical agent activity or provider billing."
     >
       <span class="codicon codicon-info" aria-hidden="true"></span>
       <span>Retained local telemetry · Partial history</span>
     </div>

    </div>
  </div>

  <!-- Sessions tab — agent conversations grouped from traces (#15) -->
  <div id="sessions-panel" class="panel" role="tabpanel">

    <!-- Master: session list -->
    <div id="sessions-list-view" class="sessions-view">
      <div class="traces-filters sessions-filters">
        <input id="sessions-search" type="text" placeholder="Search sessions by title, model, agent or id…" />
      </div>
      <div class="chat-selection-panel chat-selection-panel--empty">
        <div class="chat-selection-header">
          <span class="chat-selection-count">Chat Context (0)</span>
          <button class="chat-selection-clear-btn" title="Remove everything from chat context">Clear</button>
        </div>
        <div class="chat-selection-list">
          <span class="chat-selection-empty">No sessions, traces or spans in chat context.</span>
        </div>
        <div class="chat-selection-hint">Clears automatically once a chat request uses it.</div>
      </div>
      <div id="sessions-list" class="list-container">
        <div class="empty-state">Loading sessions…</div>
      </div>
      <div
        class="analytics-scope session-retention-note"
        role="note"
        title="Agent Insights retains a bounded amount of raw telemetry to limit memory, disk usage, and reload time."
      >
        <span class="codicon codicon-info" aria-hidden="true"></span>
        <span>Older sessions may expire due to storage limits.</span>
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
              <span class="session-logs-title">Logs</span>
              <span id="session-logs-count" class="session-logs-count">Loading…</span>
            </div>
            <div class="session-logs-body">
              <div id="session-logs-list" class="session-logs-list" aria-busy="true"></div>
            </div>
          </section>
        </div>
        <div class="traces-divider" id="session-divider" title="Drag to resize"></div>
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
            <div class="trace-type-filter">
              <button id="trace-type-filter-btn" class="filter-toggle" type="button"
                      aria-haspopup="true" aria-expanded="false">Agent activity <span class="header-filter-icon">▾</span></button>
              <div id="trace-type-filter-dropdown" class="header-filter-dropdown header-filter-dropdown--right"
                   style="display:none"></div>
            </div>
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
            <div class="chat-selection-hint">Clears automatically once a chat request uses it.</div>
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

      <!-- Right: conversation / span detail panel -->
      <div class="traces-right" id="span-detail-panel">
        <div class="span-detail-placeholder">
          ← Select a trace to read its conversation, or click a span for its details
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
    if (this.disposed) { return; }
    this.disposed = true;
    AgentInsightsPanel.currentPanel = undefined;
    this.panel.dispose();
    for (const d of this.disposables) { d.dispose(); }
    this.disposables.length = 0;
  }
}

function formatItemsForChat(
  traces: Record<string, unknown>[],
  spans: Record<string, unknown>[],
  sessions: Record<string, unknown>[] = [],
): string {
  const parts: string[] = [];
  // Sessions are the broadest selection scope.
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

  // Request conversation-level analysis for a session-only selection.
  const detail = sessions.length > 1
    ? 'what the agents were asked to do, what they actually did'
    : 'what the agent was asked to do, what it actually did';
  const instruction = sessions.length && !traces.length && !spans.length
    ? `Analyze ${parts[0]}: ${detail}, the outcome, and the root cause of any failure or slowdown.`
    : `Look at ${parts.join(' and ')}`;

  return `${refs.join(' ')} ${instruction}`;
}

function getNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  return Array.from({ length: 32 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}
