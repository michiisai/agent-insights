// @ts-check
// Runs inside the VS Code webview (browser context, no Node.js).
(function () {
  'use strict';

  // ── VS Code API ──────────────────────────────────────────────────────────────
  // @ts-ignore
  const vscode = acquireVsCodeApi();

  // ── State ────────────────────────────────────────────────────────────────────
  let activeTab = 'home';
  /** @type {Set<string>} */
  const expandedTraces = new Set();
  /** @type {Set<string>} */
  const selectedTraceIds = new Set();
  /** @type {Map<string, any>} - key: spanId, value: span data */
  const selectedSpans = new Map();

  // ── Elements ─────────────────────────────────────────────────────────────────
  const $ = (/** @type {string} */ id) => document.getElementById(id);

  const statusBadge    = $('status-badge');
  const refreshBtn     = $('refresh-btn');
  const clearBtn       = $('clear-btn');
  const tracesList     = $('traces-list');
  const chatSelectionPanel = $('chat-selection-panel');
  const chatSelectionCount = $('chat-selection-count');
  const chatSelectionList  = $('chat-selection-list');
  const chatSelectionClear = $('chat-selection-clear');
  const logsList       = $('logs-list');
  const logDetailPanel = $('log-detail-panel');
  const logFilter      = /** @type {HTMLInputElement}  */ ($('log-filter'));
  const logFilterIcon  = $('log-filter-icon');
  const traceSearch    = /** @type {HTMLInputElement}  */ ($('trace-search'));
  const traceErrBtn    = $('trace-errors-btn');
  const serviceFilterBtn      = $('service-filter-btn');
  const serviceFilterDropdown = $('service-filter-dropdown');
  const timeSortBtn  = $('time-sort-btn');
  const timeSortIcon = $('time-sort-icon');
  const logTimeSortBtn  = $('log-time-sort-btn');
  const logTimeSortIcon = $('log-time-sort-icon');
  const logServiceFilterBtn      = $('log-service-filter-btn');
  const logServiceFilterDropdown = $('log-service-filter-dropdown');
  const metricsList      = $('metrics-list');
  const metricDetailPanel = $('metric-detail-panel');
  const metricFilter     = /** @type {HTMLInputElement} */ ($('metric-filter'));

  // Sessions tab elements
  const sessionsListView   = $('sessions-list-view');
  const sessionDetailView  = $('session-detail-view');
  const sessionsList       = $('sessions-list');
  const sessionSummary     = $('session-summary');
  const sessionTracesList  = $('session-traces-list');
  const sessionBackBtn     = $('session-back-btn');

  /** @type {string} currently selected service filter */
  let selectedService = '';
  /** @type {'desc'|'asc'} */
  let timeSortOrder = 'desc';
  /** @type {string} currently selected log service filter */
  let selectedLogService = '';
  /** @type {'desc'|'asc'} */
  let logTimeSortOrder = 'desc';

  let errorsOnly = false;
  /** @type {any[]} */
  let currentInstruments = [];
  /** Currently selected metric instrument key (name|service), or null. */
  let selectedMetricKey = null;
  /** @type {any[]} */
  let currentSessions = [];
  /** Currently selected session id (null = showing the list). */
  let selectedSessionId = null;
  /** @type {any[]} */
  let currentLogs = [];
  /** Index of the currently selected log row (-1 = none) */
  let selectedLogIdx = -1;
  /** Pending deeplink: after navigating to traces, auto-expand this trace and highlight this span */
  /** @type {{ traceId: string, spanId: string | null } | null} */
  let pendingDeeplink = null;
  /** @type {Map<string, any>} */
  let traceDataMap = new Map();
  /** @type {any} */
  let currentSpanNode = null;

  // ── Tab switching ─────────────────────────────────────────────────────────────
  /** Pending debounced Home metrics fetch (cancelled if you leave Home first). */
  let homeFetchTimer = null;

  /** Activate a top-level panel and load its data. Driven by the native
   *  activity-bar sidebar via the 'switchTab' message from the extension host. */
  function switchTab(/** @type {string} */ name, /** @type {boolean} */ fromHost = false) {
    if (!name) { return; }
    // Cancel any pending Home fetch so flipping through Home doesn't trigger the
    // expensive metrics scan (which blocks the synchronous extension host).
    if (homeFetchTimer) { clearTimeout(homeFetchTimer); homeFetchTimer = null; }
    document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
    const panel = $(`${name}-panel`);
    if (panel) { panel.classList.add('active'); }
    activeTab = name;
    // When the switch originates in the webview (e.g. clicking a trace link),
    // tell the host so the activity-bar sidebar selection follows. Changes that
    // came *from* the sidebar (fromHost) already have the right selection.
    if (!fromHost) { vscode.postMessage({ type: 'tabChanged', tab: name }); }
    loadCurrentTab();
  }

  function loadCurrentTab() {
    if (activeTab === 'home') {
      // Debounced: only fetch if the user actually lingers on Home. Quick
      // pass-throughs never fire the costly getMetrics query.
      if (homeFetchTimer) { clearTimeout(homeFetchTimer); }
      homeFetchTimer = setTimeout(() => {
        homeFetchTimer = null;
        if (activeTab === 'home') {
          vscode.postMessage({ type: 'getMetrics' });
          vscode.postMessage({ type: 'getUtilityCalls' });
        }
      }, 250);
    }
    else if (activeTab === 'traces')      { vscode.postMessage({ type: 'getServices' }); fetchTraces(); }
    else if (activeTab === 'logs')        { vscode.postMessage({ type: 'getLogServices' }); fetchLogs(); }
    else if (activeTab === 'metrics')     { vscode.postMessage({ type: 'getMetricInstruments' }); }
    else if (activeTab === 'sessions')    { showSessionsList(); vscode.postMessage({ type: 'getSessions' }); }
  }

  /** Switch to Traces tab, filter to the given trace ID, and optionally highlight a span */
  function navigateToTrace(/** @type {string} */ traceId, /** @type {string|null} */ spanId = null) {
    // Set deeplink + search first so switchTab's fetchTraces picks them up.
    pendingDeeplink = { traceId, spanId };
    if (traceSearch) { traceSearch.value = traceId; }
    switchTab('traces');
  }

  function fetchTraces() {
    vscode.postMessage({
      type:       'getTraces',
      search:     traceSearch?.value  || undefined,
      service:    selectedService     || undefined,
      errorsOnly: errorsOnly || undefined,
      sortOrder:  timeSortOrder,
    });
  }

  function fetchLogs() {
    const raw = logFilter.value.trim();
    const tokens = raw.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [];

    let filter    = '';
    let sinceNano = '';
    let untilNano = '';
    /** @type {string[]} */
    const excludes = [];
    /** @type {string[]} */
    const includes = [];

    for (const tok of tokens) {
      const lower = tok.toLowerCase();
      if (lower.startsWith('after:')) {
        const ts = parseTimestamp(tok.slice(6));
        if (ts) { sinceNano = ts; }
      } else if (lower.startsWith('before:')) {
        const ts = parseTimestamp(tok.slice(7));
        if (ts) { untilNano = ts; }
      } else if (tok.startsWith('!') && tok.length > 1) {
        excludes.push(tok.slice(1));
      } else {
        includes.push(tok);
      }
    }
    filter = includes.join(' ');

    const hasAdvanced = excludes.length > 0 || sinceNano || untilNano;
    logFilterIcon?.classList.toggle('active', hasAdvanced);

    vscode.postMessage({
      type:        'getLogs',
      filter:      filter || undefined,
      excludes:    excludes.length ? excludes : undefined,
      sinceNano:   sinceNano || undefined,
      untilNano:   untilNano || undefined,
      serviceName: selectedLogService || undefined,
      sortOrder:   logTimeSortOrder,
    });
  }

  /** @param {string} s @returns {string} nanoseconds string or '' */
  function parseTimestamp(s) {
    try {
      const ms = Date.parse(s);
      if (isNaN(ms)) { return ''; }
      return String(BigInt(ms) * 1_000_000n);
    } catch { return ''; }
  }

  refreshBtn?.addEventListener('click', loadCurrentTab);

  clearBtn?.addEventListener('click', () => {
    vscode.postMessage({ type: 'clearData' });
  });
  chatSelectionClear?.addEventListener('click', () => {
    selectedTraceIds.clear();
    selectedSpans.clear();
    if (tracesList) {
      tracesList.querySelectorAll('.add-to-chat-btn').forEach(btn => {
        btn.textContent = '+ chat';
        btn.classList.remove('add-to-chat-btn--selected');
      });
    }
    if (currentSpanNode) {
      const btn = $('span-detail-panel')?.querySelector('.add-to-chat-btn');
      if (btn) {
        btn.textContent = '+ chat';
        btn.classList.remove('add-to-chat-btn--selected');
      }
    }
    renderChatSelection();
    syncAllToChat();
  });
  chatSelectionList?.addEventListener('click', e => {
    const removeBtn = /** @type {HTMLElement} */ (e.target)?.closest('.chat-selection-chip-remove');
    if (!removeBtn) { return; }
    const chip = removeBtn.closest('[data-chat-kind][data-chat-id]');
    if (!chip) { return; }
    const kind = chip.dataset.chatKind;
    const id = chip.dataset.chatId ?? '';
    if (!id) { return; }

    if (kind === 'trace') {
      selectedTraceIds.delete(id);
      const btn = tracesList?.querySelector(`.trace-row[data-id="${id}"] .add-to-chat-btn`);
      if (btn) {
        btn.textContent = '+ chat';
        btn.classList.remove('add-to-chat-btn--selected');
      }
    } else if (kind === 'span') {
      selectedSpans.delete(id);
      if (currentSpanNode?.spanId === id) {
        const btn = $('span-detail-panel')?.querySelector('.add-to-chat-btn');
        if (btn) {
          btn.textContent = '+ chat';
          btn.classList.remove('add-to-chat-btn--selected');
        }
      }
    }

    renderChatSelection();
    syncAllToChat();
  });

  // Log time sort toggle
  logTimeSortBtn?.addEventListener('click', () => {
    logTimeSortOrder = logTimeSortOrder === 'desc' ? 'asc' : 'desc';
    if (logTimeSortIcon) { logTimeSortIcon.textContent = logTimeSortOrder === 'desc' ? '↓' : '↑'; }
    logTimeSortBtn.classList.toggle('header-filter-btn--active', logTimeSortOrder === 'asc');
    fetchLogs();
  });

  // Log service filter dropdown toggle
  logServiceFilterBtn?.addEventListener('click', e => {
    e.stopPropagation();
    if (!logServiceFilterDropdown) { return; }
    const isOpen = logServiceFilterDropdown.style.display !== 'none';
    logServiceFilterDropdown.style.display = isOpen ? 'none' : 'block';
  });

  logFilter?.addEventListener('input', fetchLogs);
  logFilter?.addEventListener('keydown', e => { if (e.key === 'Enter') { fetchLogs(); } });

  traceSearch?.addEventListener('input', fetchTraces);
  traceSearch?.addEventListener('keydown', e => { if (e.key === 'Enter') { fetchTraces(); } });
  traceErrBtn?.addEventListener('click', () => {
    errorsOnly = !errorsOnly;
    traceErrBtn.classList.toggle('active', errorsOnly);
    fetchTraces();
  });

  // Back navigation from a session's detail view to the list.
  sessionBackBtn?.addEventListener('click', () => {
    showSessionsList();
    renderSessions(currentSessions);
  });

  // Time sort toggle
  timeSortBtn?.addEventListener('click', () => {
    timeSortOrder = timeSortOrder === 'desc' ? 'asc' : 'desc';
    if (timeSortIcon) { timeSortIcon.textContent = timeSortOrder === 'desc' ? '↓' : '↑'; }
    timeSortBtn.classList.toggle('header-filter-btn--active', timeSortOrder === 'asc');
    fetchTraces();
  });

  // Service filter dropdown toggle
  serviceFilterBtn?.addEventListener('click', e => {
    e.stopPropagation();
    if (!serviceFilterDropdown) { return; }
    const isOpen = serviceFilterDropdown.style.display !== 'none';
    serviceFilterDropdown.style.display = isOpen ? 'none' : 'block';
  });

  // Close dropdowns when clicking outside
  document.addEventListener('click', () => {
    if (serviceFilterDropdown)    { serviceFilterDropdown.style.display = 'none'; }
    if (logServiceFilterDropdown) { logServiceFilterDropdown.style.display = 'none'; }
  });

  // ── Traces panel resize ───────────────────────────────────────────────────────
  (function initResizer() {
    const divider    = $('traces-divider');
    const rightPanel = $('span-detail-panel');
    const split      = divider?.parentElement;
    if (!divider || !rightPanel || !split) { return; }

    // Cast to non-null after guard so TypeScript doesn't complain inside closures
    const divEl   = /** @type {HTMLElement} */ (divider);
    const rightEl = /** @type {HTMLElement} */ (rightPanel);
    const splitEl = /** @type {HTMLElement} */ (split);

    let startX = 0;
    let startW = 0;

    divEl.addEventListener('mousedown', e => {
      startX = e.clientX;
      startW = rightEl.getBoundingClientRect().width;
      divEl.classList.add('dragging');
      document.body.style.cursor = 'ew-resize';
      document.body.style.userSelect = 'none';

      function onMove(/** @type {MouseEvent} */ ev) {
        const delta  = startX - ev.clientX;
        const splitW = splitEl.getBoundingClientRect().width;
        const newW   = Math.min(Math.max(startW + delta, splitW * 0.2), splitW * 0.5);
        rightEl.style.width = `${newW}px`;
      }

      function onUp() {
        divEl.classList.remove('dragging');
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
      }

      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
      e.preventDefault();
    });
  }());

  // ── Logs panel resize ─────────────────────────────────────────────────────────
  (function initLogsResizer() {
    const divider    = $('logs-divider');
    const rightPanel = $('log-detail-panel');
    const split      = divider?.parentElement;
    if (!divider || !rightPanel || !split) { return; }

    const divEl   = /** @type {HTMLElement} */ (divider);
    const rightEl = /** @type {HTMLElement} */ (rightPanel);
    const splitEl = /** @type {HTMLElement} */ (split);

    let startX = 0;
    let startW = 0;

    divEl.addEventListener('mousedown', e => {
      startX = e.clientX;
      startW = rightEl.getBoundingClientRect().width;
      divEl.classList.add('dragging');
      document.body.style.cursor = 'ew-resize';
      document.body.style.userSelect = 'none';

      function onMove(/** @type {MouseEvent} */ ev) {
        const delta  = startX - ev.clientX;
        const splitW = splitEl.getBoundingClientRect().width;
        const newW   = Math.min(Math.max(startW + delta, splitW * 0.2), splitW * 0.5);
        rightEl.style.width = `${newW}px`;
      }

      function onUp() {
        divEl.classList.remove('dragging');
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
      }

      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
      e.preventDefault();
    });
  }());

  // ── Metrics panel resize ──────────────────────────────────────────────────────
  (function initMetricsResizer() {
    const divider    = $('metrics-divider');
    const rightPanel = $('metric-detail-panel');
    const split      = divider?.parentElement;
    if (!divider || !rightPanel || !split) { return; }

    const divEl   = /** @type {HTMLElement} */ (divider);
    const rightEl = /** @type {HTMLElement} */ (rightPanel);
    const splitEl = /** @type {HTMLElement} */ (split);

    let startX = 0;
    let startW = 0;

    divEl.addEventListener('mousedown', e => {
      startX = e.clientX;
      startW = rightEl.getBoundingClientRect().width;
      divEl.classList.add('dragging');
      document.body.style.cursor = 'ew-resize';
      document.body.style.userSelect = 'none';

      function onMove(/** @type {MouseEvent} */ ev) {
        const delta  = startX - ev.clientX;
        const splitW = splitEl.getBoundingClientRect().width;
        const newW   = Math.min(Math.max(startW + delta, splitW * 0.25), splitW * 0.65);
        rightEl.style.width = `${newW}px`;
      }

      function onUp() {
        divEl.classList.remove('dragging');
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
      }

      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
      e.preventDefault();
    });
  }());

  metricFilter && metricFilter.addEventListener('input', () => renderMetricList());

  window.addEventListener('message', event => {
    const msg = event.data;
    switch (msg.type) {
      case 'status':   renderStatus(msg);                    break;
      case 'traces':
        if (activeTab === 'sessions') { renderSessionTraces(msg.data); }
        else { renderTraces(msg.data); }
        break;
      case 'services':    renderServices(msg.data);              break;
      case 'logServices': renderLogServices(msg.data);           break;
      case 'sessions': renderSessions(msg.data);             break;
      case 'spans':    renderSpans(msg.traceId, msg.data);   break;
      case 'metrics': renderMetrics(msg.data);              break;
      case 'utilityCalls': renderUtilityCalls(msg.data);    break;
      case 'metricInstruments': renderMetricInstruments(msg.data); break;
      case 'metricDetail':      renderMetricDetail(msg.data);      break;
      case 'logs':    renderLogs(msg.data);                 break;
      case 'cleared':
        selectedTraceIds.clear();
        selectedSpans.clear();
        traceDataMap = new Map();
        renderChatSelection();
        vscode.postMessage({ type: 'getServices' });
        loadCurrentTab();
        break;
      case 'navigateToTrace': navigateToTrace(msg.traceId, msg.spanId ?? null); break;
      case 'switchTab': switchTab(msg.tab, true); break;
    }
  });

  // ── Status ────────────────────────────────────────────────────────────────────
  let _currentPort = null;

  function renderStatus(/** @type {{connected:boolean,port:number}} */ s) {
    if (!statusBadge) { return; }
    _currentPort = s.connected ? s.port : null;
    statusBadge.textContent = s.connected ? `● :${s.port}` : '● offline';
    statusBadge.className   = `badge ${s.connected ? 'badge--ok badge--clickable' : 'badge--err'}`;
    statusBadge.title       = s.connected ? `Click to copy http://127.0.0.1:${s.port}` : '';
  }

  statusBadge && statusBadge.addEventListener('click', () => {
    if (!_currentPort) { return; }
    const endpoint = `http://127.0.0.1:${_currentPort}`;
    navigator.clipboard.writeText(endpoint).then(() => {
      const prev = statusBadge.textContent;
      statusBadge.textContent = '✓ Copied!';
      setTimeout(() => { statusBadge.textContent = prev; }, 1500);
    });
  });

  // ── Services dropdown ────────────────────────────────────────────────────────
  function renderServices(/** @type {string[]} */ services) {
    if (!serviceFilterDropdown || !serviceFilterBtn) { return; }
    const allServices = ['', ...services];
    serviceFilterDropdown.innerHTML = allServices.map(s => {
      const label    = s || 'All services';
      const isActive = s === selectedService;
      return `<button class="service-filter-option${isActive ? ' active' : ''}" data-value="${esc(s)}">${esc(label)}</button>`;
    }).join('');
    serviceFilterDropdown.querySelectorAll('.service-filter-option').forEach(btn => {
      btn.addEventListener('click', e => {
        e.stopPropagation();
        selectedService = /** @type {HTMLElement} */ (btn).dataset.value ?? '';
        serviceFilterDropdown.style.display = 'none';
        const icon = $('service-filter-icon');
        serviceFilterBtn.childNodes[0].textContent = (selectedService || 'Service') + ' ';
        serviceFilterBtn.classList.toggle('header-filter-btn--active', !!selectedService);
        if (icon) { icon.textContent = '▾'; }
        fetchTraces();
      });
    });
  }

  function renderLogServices(/** @type {string[]} */ services) {
    if (!logServiceFilterDropdown || !logServiceFilterBtn) { return; }
    const allServices = ['', ...services];
    logServiceFilterDropdown.innerHTML = allServices.map(s => {
      const label    = s || 'All services';
      const isActive = s === selectedLogService;
      return `<button class="service-filter-option${isActive ? ' active' : ''}" data-value="${esc(s)}">${esc(label)}</button>`;
    }).join('');
    logServiceFilterDropdown.querySelectorAll('.service-filter-option').forEach(btn => {
      btn.addEventListener('click', e => {
        e.stopPropagation();
        selectedLogService = /** @type {HTMLElement} */ (btn).dataset.value ?? '';
        logServiceFilterDropdown.style.display = 'none';
        const icon = $('log-service-filter-icon');
        logServiceFilterBtn.childNodes[0].textContent = (selectedLogService || 'Service') + ' ';
        logServiceFilterBtn.classList.toggle('header-filter-btn--active', !!selectedLogService);
        if (icon) { icon.textContent = '▾'; }
        fetchLogs();
      });
    });
  }

  // ── Chat selection sync ──────────────────────────────────────────────────────
  function syncAllToChat() {
    const traces = [...selectedTraceIds].map(id => traceDataMap.get(id)).filter(Boolean);
    const spans  = [...selectedSpans.values()];
    vscode.postMessage({ type: 'addItemsToChat', traces, spans });
  }

  /** @param {string} value @returns {string} */
  function shortId(value) {
    if (!value) { return ''; }
    if (value.length <= 12) { return value; }
    return `${value.slice(0, 6)}…${value.slice(-4)}`;
  }

  function renderChatSelection() {
    if (!chatSelectionPanel || !chatSelectionList || !chatSelectionCount) { return; }

    const traceItems = [...selectedTraceIds].map(id => {
      const trace = traceDataMap.get(id);
      return {
        kind: 'trace',
        id,
        label: trace?.rootSpanName
          ? `Trace: ${trace.rootSpanName} (${shortId(id)})`
          : `Trace: ${shortId(id)}`,
      };
    });
    const spanItems = [...selectedSpans.values()].map(span => ({
      kind: 'span',
      id: span.spanId,
      label: span?.name
        ? `Span: ${span.name} (${shortId(span.spanId)})`
        : `Span: ${shortId(span.spanId)}`,
    }));
    const allItems = [...traceItems, ...spanItems];

    chatSelectionCount.textContent = `Chat Context (${allItems.length})`;
    chatSelectionPanel.classList.toggle('chat-selection-panel--empty', allItems.length === 0);
    if (!allItems.length) {
      chatSelectionList.innerHTML = '<span class="chat-selection-empty">No traces or spans in chat context.</span>';
      return;
    }

    chatSelectionList.innerHTML = allItems.map(item => `
      <span class="chat-selection-chip" data-chat-kind="${item.kind}" data-chat-id="${esc(item.id)}">
        <span class="chat-selection-chip-label">${esc(item.label)}</span>
        <button class="chat-selection-chip-remove" title="Remove from chat context" aria-label="Remove from chat context">✕</button>
      </span>
    `).join('');
  }

  // ── Sessions ──────────────────────────────────────────────────────────────────
  /** Show the master list, hide the detail view. */
  function showSessionsList() {
    selectedSessionId = null;
    if (sessionsListView)  { sessionsListView.style.display  = ''; }
    if (sessionDetailView) { sessionDetailView.style.display = 'none'; }
  }

  /** Show the detail explorer for a single session, hide the list. */
  function showSessionDetail() {
    if (sessionsListView)  { sessionsListView.style.display  = 'none'; }
    if (sessionDetailView) { sessionDetailView.style.display = ''; }
  }

  /** Render the full session list (newest first, as returned by the engine). */
  function renderSessions(/** @type {any[]} */ sessions) {
    currentSessions = sessions || [];
    if (!sessionsList) { return; }
    if (!currentSessions.length) {
      sessionsList.innerHTML = `<div class="empty-state">No sessions yet.<br><small>Agent conversations (Copilot, Claude Code) appear here once telemetry arrives.</small></div>`;
      return;
    }
    sessionsList.innerHTML = currentSessions.map(sessionRowHtml).join('');
    sessionsList.querySelectorAll('.session-row').forEach(row => {
      row.addEventListener('click', () => {
        const id = /** @type {HTMLElement} */ (row).dataset.id ?? '';
        selectSession(id);
      });
    });
  }

  /** @param {any} s */
  function sessionRowHtml(s) {
    const models = (s.models || []).join(', ');
    const dur    = fmtMs(s.durationMs);
    const tokens = s.totalTokens ? `${fmtNum(s.totalTokens)} tok` : '';
    return `
      <div class="session-row ${s.hasError ? 'row--error' : ''}" data-id="${esc(s.sessionId)}">
        <span class="session-status ${s.hasError ? 'session-status--err' : 'session-status--ok'}" title="${s.hasError ? 'Failed' : 'OK'}"></span>
        <span class="session-cell session-cell--main">
          <span class="session-title">${esc(models || s.serviceName)}</span>
          <span class="session-id">${esc(s.sessionId)}</span>
        </span>
        <span class="session-cell session-cell--service">${esc(s.serviceName)}</span>
        <span class="session-cell session-cell--ts">${fmtNano(s.startTimeUnixNano)}</span>
        <span class="session-cell session-cell--metric">${s.traceCount} trace${s.traceCount !== 1 ? 's' : ''}</span>
        <span class="session-cell session-cell--metric">${s.llmRequestCount} LLM</span>
        <span class="session-cell session-cell--metric">${s.toolCallCount} tool${s.toolCallCount !== 1 ? 's' : ''}</span>
        <span class="session-cell session-cell--metric">${dur}${tokens ? ' · ' + tokens : ''}</span>
      </div>
    `;
  }

  /** Open a session: render its summary card and fetch its traces. */
  function selectSession(/** @type {string} */ sessionId) {
    selectedSessionId = sessionId;
    const s = currentSessions.find(x => x.sessionId === sessionId);
    showSessionDetail();
    renderSessionSummary(s);
    // Reset the span-detail pane + traces list for the new session.
    const detail = $('session-span-detail');
    if (detail) { detail.innerHTML = `<div class="span-detail-placeholder">← Expand a trace and click a span to view its details</div>`; }
    if (sessionTracesList) { sessionTracesList.innerHTML = `<div class="empty-state">Loading traces…</div>`; }
    vscode.postMessage({ type: 'getTraces', sessionId, sortOrder: 'asc' });
  }

  /** @param {any} s */
  function renderSessionSummary(s) {
    if (!sessionSummary) { return; }
    if (!s) { sessionSummary.innerHTML = ''; return; }
    const models = (s.models || []).join(', ') || '—';
    const statusChip = s.hasError
      ? `<span class="session-chip session-chip--err">Failed</span>`
      : `<span class="session-chip session-chip--ok">OK</span>`;
    const failure = s.hasError && s.failureReason
      ? `<div class="session-failure"><span class="session-failure-label">Failure reason</span><span class="session-failure-text">${esc(s.failureReason)}</span></div>`
      : '';
    const stat = (/** @type {string} */ label, /** @type {string} */ value) =>
      `<div class="session-stat"><div class="session-stat-value">${value}</div><div class="session-stat-label">${label}</div></div>`;
    sessionSummary.innerHTML = `
      <div class="session-summary-head">
        ${statusChip}
        <span class="session-summary-service">${esc(s.serviceName)}</span>
        <span class="session-summary-id">${esc(s.sessionId)}</span>
      </div>
      <div class="session-summary-models">Models: <strong>${esc(models)}</strong></div>
      <div class="session-stats">
        ${stat('Traces',       String(s.traceCount))}
        ${stat('Spans',        String(s.spanCount))}
        ${stat('LLM requests', String(s.llmRequestCount))}
        ${stat('Tool calls',   String(s.toolCallCount))}
        ${stat('Tokens',       s.totalTokens ? fmtNum(s.totalTokens) : '—')}
        ${stat('Duration',     fmtMs(s.durationMs))}
      </div>
      ${failure}
    `;
  }

  /** Render a session's traces (reuses the trace-row look; expands to span waterfalls). */
  function renderSessionTraces(/** @type {any[]} */ traces) {
    if (!sessionTracesList) { return; }
    if (!traces.length) {
      sessionTracesList.innerHTML = `<div class="empty-state">No traces in this session.</div>`;
      return;
    }
    sessionTracesList.innerHTML = traces.map(t => {
      const isOpen = expandedTraces.has(t.traceId);
      return `
        <div class="trace-row ${t.hasError ? 'row--error' : ''} ${isOpen ? '' : 'collapsed'}" data-id="${esc(t.traceId)}">
          <span class="expand-icon" aria-hidden="true">${isOpen ? '▾' : '▸'}</span>
          <span class="cell cell--name">
            <span class="trace-name">${esc(t.rootSpanName)}</span>
            <span class="trace-id">${esc(t.traceId)}</span>
          </span>
          <span class="cell cell--service">${esc(t.serviceName)}</span>
          <span class="cell cell--ts">${fmtNano(t.startTimeUnixNano)}</span>
          <span class="cell cell--dur">${fmtMs(t.durationMs)}</span>
          <span class="cell cell--spans">${t.spanCount} span${t.spanCount !== 1 ? 's' : ''}</span>
        </div>
        <div class="waterfall-container" id="ssc-${esc(t.traceId)}" data-span-container="${esc(t.traceId)}"
             style="display:${isOpen ? 'block' : 'none'}">
          <div class="loading-row">loading spans…</div>
        </div>
      `;
    }).join('');

    sessionTracesList.querySelectorAll('.trace-row').forEach(row => {
      row.addEventListener('click', () => {
        const id        = /** @type {HTMLElement} */ (row).dataset.id ?? '';
        const container = $(`ssc-${id}`);
        const icon      = row.querySelector('.expand-icon');
        if (!container) { return; }
        if (expandedTraces.has(id)) {
          expandedTraces.delete(id);
          container.style.display = 'none';
          row.classList.add('collapsed');
          if (icon) { icon.textContent = '▸'; }
        } else {
          expandedTraces.add(id);
          container.style.display = 'block';
          row.classList.remove('collapsed');
          if (icon) { icon.textContent = '▾'; }
          vscode.postMessage({ type: 'getSpans', traceId: id });
        }
      });
    });
  }

  // ── Traces ────────────────────────────────────────────────────────────────────
  function renderTraces(/** @type {any[]} */ traces) {
    if (!tracesList) { return; }
    if (!traces.length) {
      tracesList.innerHTML = `<div class="empty-state">No traces yet.<br><small>Point your app's OTLP exporter at <code>http://127.0.0.1:${_currentPort ?? 4318}</code></small></div>`;
      renderChatSelection();
      return;
    }

    traceDataMap = new Map(traces.map(t => [t.traceId, t]));
    // Re-render clears DOM buttons, so sync selectedTraceIds to only known traces
    for (const id of selectedTraceIds) { if (!traceDataMap.has(id)) { selectedTraceIds.delete(id); } }
    renderChatSelection();
    tracesList.innerHTML = traces.map(t => {
      const isOpen     = expandedTraces.has(t.traceId);
      const isSelected = selectedTraceIds.has(t.traceId);
      return `
        <div class="trace-row ${t.hasError ? 'row--error' : ''} ${isOpen ? '' : 'collapsed'}" data-id="${esc(t.traceId)}">
          <span class="expand-icon" aria-hidden="true">${isOpen ? '▾' : '▸'}</span>
          <span class="cell cell--name">
            <span class="trace-name">${esc(t.rootSpanName)}</span>
            <span class="trace-id">${esc(t.traceId)}</span>
          </span>
          <span class="cell cell--service">${esc(t.serviceName)}</span>
          <span class="cell cell--ts">${fmtNano(t.startTimeUnixNano)}</span>
          <span class="cell cell--dur">${fmtMs(t.durationMs)}</span>
          <span class="cell cell--spans">${t.spanCount} span${t.spanCount !== 1 ? 's' : ''}</span>
          <button class="add-to-chat-btn${isSelected ? ' add-to-chat-btn--selected' : ''}" title="Add trace to chat" tabindex="-1">${isSelected ? '✓ added' : '+ chat'}</button>
        </div>
        <div class="waterfall-container" id="sc-${esc(t.traceId)}"
             style="display:${isOpen ? 'block' : 'none'}">
          <div class="loading-row">loading spans…</div>
        </div>
      `;
    }).join('');

    tracesList.querySelectorAll('.trace-row').forEach(row => {
      row.addEventListener('click', () => {
        const id        = /** @type {HTMLElement} */ (row).dataset.id ?? '';
        const container = $(`sc-${id}`);
        const icon      = row.querySelector('.expand-icon');
        if (!container) { return; }

        if (expandedTraces.has(id)) {
          expandedTraces.delete(id);
          container.style.display = 'none';
          row.classList.add('collapsed');
          if (icon) { icon.textContent = '▸'; }
        } else {
          expandedTraces.add(id);
          container.style.display = 'block';
          row.classList.remove('collapsed');
          if (icon) { icon.textContent = '▾'; }
          vscode.postMessage({ type: 'getSpans', traceId: id });
        }
      });
    });

    // Add-to-chat buttons: stop propagation so row expand/collapse doesn't fire
    tracesList.querySelectorAll('.add-to-chat-btn').forEach(btn => {
      btn.addEventListener('click', e => {
        e.stopPropagation();
        const row = /** @type {HTMLElement} */ (/** @type {HTMLElement} */ (btn).closest('.trace-row'));
        const id  = row?.dataset?.id;
        if (!id) { return; }
        if (selectedTraceIds.has(id)) {
          selectedTraceIds.delete(id);
          btn.textContent = '+ chat';
          btn.classList.remove('add-to-chat-btn--selected');
        } else {
          selectedTraceIds.add(id);
          btn.textContent = '✓ added';
          btn.classList.add('add-to-chat-btn--selected');
        }
        renderChatSelection();
        syncAllToChat();
      });
    });

    // If a deeplink is pending, auto-expand the target trace
    if (pendingDeeplink) {
      const { traceId: dlTraceId } = pendingDeeplink;
      const targetRow = tracesList.querySelector(`.trace-row[data-id="${dlTraceId}"]`);
      const container = $(`sc-${dlTraceId}`);
      const icon      = targetRow?.querySelector('.expand-icon');
      if (targetRow && container) {
        expandedTraces.add(dlTraceId);
        container.style.display = 'block';
        targetRow.classList.remove('collapsed');
        if (icon) { icon.textContent = '▾'; }
        targetRow.scrollIntoView({ block: 'start', behavior: 'smooth' });
        vscode.postMessage({ type: 'getSpans', traceId: dlTraceId });
      }
    }
  }

  // ── Span waterfall ────────────────────────────────────────────────────────────
  function renderSpans(/** @type {string} */ traceId, /** @type {any[]} */ spans) {
    // A trace can be shown in two places (Traces tab + Session detail); fill both.
    const containers = [$(`sc-${traceId}`), $(`ssc-${traceId}`)].filter(Boolean);
    if (!containers.length) { return; }
    if (!spans.length) {
      containers.forEach(c => { c.innerHTML = '<div class="empty-state small">No spans found.</div>'; });
      return;
    }

    // Build parent-child tree
    /** @type {Record<string,any>} */
    const byId = {};
    spans.forEach(s => { byId[s.spanId] = { ...s, children: [] }; });
    /** @type {any[]} */
    const roots = [];
    spans.forEach(s => {
      if (s.parentSpanId && byId[s.parentSpanId]) {
        byId[s.parentSpanId].children.push(byId[s.spanId]);
      } else {
        roots.push(byId[s.spanId]);
      }
    });

    // Compute timeline range with BigInt for nanosecond precision
    let traceStartNano = BigInt(spans[0].startTimeUnixNano);
    let traceEndNano   = traceStartNano;
    spans.forEach(s => {
      const start = BigInt(s.startTimeUnixNano);
      const end   = start + BigInt(Math.round(s.durationMs * 1_000_000));
      if (start < traceStartNano) { traceStartNano = start; }
      if (end   > traceEndNano)   { traceEndNano   = end; }
    });
    const traceTotalNano = traceEndNano - traceStartNano;

    /** @param {any} node @param {number} depth @returns {string} */
    function nodeHtml(node, depth) {
      const isErr     = node.statusCode === 2;
      const indent    = depth * 14;
      const startNano = BigInt(node.startTimeUnixNano);
      const durNano   = BigInt(Math.round(node.durationMs * 1_000_000));
      const offsetPct = traceTotalNano > 0n
        ? Number((startNano - traceStartNano) * 10000n / traceTotalNano) / 100
        : 0;
      const widthPct = traceTotalNano > 0n
        ? Math.max(0.3, Number(durNano * 10000n / traceTotalNano) / 100)
        : 100;
      const barColor = isErr ? 'var(--err)' : spanKindColor(node.kind);

      return `
        <div class="waterfall-row ${isErr ? 'row--error' : ''}"
             data-span-id="${esc(node.spanId)}"
             data-trace-id="${esc(traceId)}">
          <div class="waterfall-info" style="padding-left:${indent + 4}px">
            <span class="span-kind kind-${node.kind}">${SPAN_KIND[node.kind] ?? '?'}</span>
            <span class="waterfall-name" title="${esc(node.name)}">${esc(node.name)}</span>
          </div>
          <div class="waterfall-bar-area">
            <div class="waterfall-bar"
                 style="left:${offsetPct.toFixed(2)}%;width:${widthPct.toFixed(2)}%;background:${barColor}">
            </div>
          </div>
          <span class="waterfall-dur">${fmtMs(node.durationMs)}</span>
          <span class="pill pill--err${isErr ? '' : ' pill--hidden'}" aria-hidden="${isErr ? 'false' : 'true'}">ERR</span>
        </div>
        ${node.children.map((/** @type {any} */ c) => nodeHtml(c, depth + 1)).join('')}
      `;
    }

    const html = roots.map(r => nodeHtml(r, 0)).join('');

    containers.forEach(container => {
      container.innerHTML = html;
      // Clicking a span row shows its detail in the active tab's detail panel.
      container.querySelectorAll('.waterfall-row').forEach(row => {
        row.addEventListener('click', () => {
          const spanId = /** @type {HTMLElement} */ (row).dataset.spanId ?? '';
          const node   = byId[spanId];
          if (!node) { return; }
          document.querySelectorAll('.waterfall-row.selected').forEach(r => r.classList.remove('selected'));
          row.classList.add('selected');
          showSpanDetail(node);
        });
      });
    });

    // If a deeplink is pending for this trace, highlight + scroll to the target span
    // (deeplinks only target the Traces tab container).
    const container = containers[0];
    if (pendingDeeplink && pendingDeeplink.traceId === traceId && pendingDeeplink.spanId) {
      const targetSpanId = pendingDeeplink.spanId;
      pendingDeeplink = null; // consume
      const targetRow = /** @type {HTMLElement|null} */ (
        container.querySelector(`.waterfall-row[data-span-id="${targetSpanId}"]`)
      );
      if (targetRow) {
        document.querySelectorAll('.waterfall-row.selected').forEach(r => r.classList.remove('selected'));
        targetRow.classList.add('selected');
        targetRow.scrollIntoView({ block: 'center', behavior: 'smooth' });
        const node = byId[targetSpanId];
        if (node) { showSpanDetail(node); }
      }
    } else if (pendingDeeplink && pendingDeeplink.traceId === traceId) {
      pendingDeeplink = null; // consume (trace-only deeplink, no span to highlight)
    }
  }

  /** @param {number} kind @returns {string} */
  function spanKindColor(kind) {
    switch (kind) {
      case 1:  return '#b39ddb'; // INTERNAL  — soft purple
      case 2:  return '#4fc3f7'; // SERVER    — sky blue
      case 3:  return '#4ec9b0'; // CLIENT    — teal
      case 4:  return '#ffa726'; // PRODUCER  — amber
      case 5:  return '#81c784'; // CONSUMER  — green
      default: return '#888888'; // UNSPECIFIED — gray
    }
  }

  /** @param {any} node */
  function showSpanDetail(node) {
    // Render into the active tab's detail pane. The Sessions view has no chat
    // integration, so its span detail is read-only (no +chat button).
    const inSession = activeTab === 'sessions';
    const panel = $(inSession ? 'session-span-detail' : 'span-detail-panel');
    if (!panel) { return; }
    currentSpanNode = node;
    const isSelected = selectedSpans.has(node.spanId);
    const chatBtn = inSession
      ? ''
      : `<button class="add-to-chat-btn add-to-chat-btn--visible${isSelected ? ' add-to-chat-btn--selected' : ''}" title="Add span to chat">${isSelected ? '✓ added' : '+ chat'}</button>`;
    panel.innerHTML = `
      <div class="span-detail-panel-header">
        <span>Span Details</span>
        ${chatBtn}
      </div>
      ${spanDetailHtml(node)}
    `;
  }

  // Add-to-chat button in span detail panel
  $('span-detail-panel')?.addEventListener('click', e => {
    if (/** @type {HTMLElement} */ (e.target)?.closest('.add-to-chat-btn')) {
      if (!currentSpanNode) { return; }
      const spanId = currentSpanNode.spanId;
      const btn = /** @type {HTMLElement} */ (/** @type {HTMLElement} */ (e.target).closest('.add-to-chat-btn'));
      if (selectedSpans.has(spanId)) {
        selectedSpans.delete(spanId);
        if (btn) { btn.textContent = '+ chat'; btn.classList.remove('add-to-chat-btn--selected'); }
      } else {
        const { children: _c, ...spanData } = currentSpanNode;
        selectedSpans.set(spanId, spanData);
        if (btn) { btn.textContent = '✓ added'; btn.classList.add('add-to-chat-btn--selected'); }
      }
      renderChatSelection();
      syncAllToChat();
      return;
    }
  });

  // Toggle long attribute values in the right panel (delegated)
  $('span-detail-panel')?.addEventListener('click', e => {
    const row = /** @type {HTMLElement} */ (e.target)?.closest('.attr-row-long');
    if (!row) { return; }
    const textEl    = row.querySelector('.attr-val-text');
    const chevron   = row.querySelector('.attr-chevron');
    if (!textEl) { return; }
    const collapsed = textEl.classList.toggle('collapsed');
    if (chevron) { chevron.textContent = collapsed ? '▶' : '▾'; }
  });

  // Toggle collapsible gen_ai conversation blocks (works in any detail pane).
  document.addEventListener('click', e => {
    const head = /** @type {HTMLElement} */ (e.target)?.closest('.genai-block-head');
    if (!head) { return; }
    const block = head.closest('.genai-block');
    if (!block) { return; }
    const collapsed = block.classList.toggle('genai-collapsed');
    const chevron = head.querySelector('.genai-chevron');
    if (chevron) { chevron.textContent = collapsed ? '▶' : '▾'; }
  });

  /** @param {any} node @returns {string} */
  function spanDetailHtml(node) {
    const STATUS_LABELS = ['UNSET', 'OK', 'ERROR'];
    const KIND_LABELS   = ['UNSPECIFIED', 'INTERNAL', 'SERVER', 'CLIENT', 'PRODUCER', 'CONSUMER'];
    const statusText    = STATUS_LABELS[node.statusCode] ?? String(node.statusCode);
    const kindText      = KIND_LABELS[node.kind]         ?? String(node.kind);
    // gen_ai.* content is rendered as a readable conversation below; keep those
    // keys out of the raw Attributes table to avoid huge duplicate JSON dumps.
    const contentHtml   = genaiContentHtml(node);
    const attrEntries   = Object.entries(node.attributes ?? {})
      .filter(([k]) => !GENAI_CONTENT_KEYS.has(k));

    const metaHtml = [
      ['Span ID',   `<span class="mono">${esc(node.spanId)}</span>`],
      ['Duration',  `<span class="mono">${fmtMs(node.durationMs)}</span>`],
      ['Kind',      kindText],
      ['Status',    `<span class="${node.statusCode === 2 ? 'text-err' : ''}">${statusText}${node.statusMessage ? ': ' + esc(node.statusMessage) : ''}</span>`],
      ['Start',     `<span class="mono">${fmtNano(node.startTimeUnixNano)}</span>`],
    ].map(([k, v]) => `<div class="meta-key">${k}</div><div class="meta-val">${v}</div>`).join('');

    const LONG_THRESHOLD = 120;

    const attrsHtml = attrEntries.length > 0
      ? `<div class="attrs-section">
           <div class="attrs-title">Attributes (${attrEntries.length})</div>
           <table class="attrs-table">
             ${attrEntries.map(([k, v]) => {
               const text = fmtAttr(v);
               const isLong = text.length > LONG_THRESHOLD;
               const keyCell = isLong
                 ? `<td class="attr-key"><span class="attr-chevron">▶</span>${esc(k)}</td>`
                 : `<td class="attr-key">${esc(k)}</td>`;
               const valCell = isLong
                 ? `<td class="attr-val"><span class="attr-val-text collapsed">${esc(text)}</span></td>`
                 : `<td class="attr-val"><span class="attr-val-text">${esc(text)}</span></td>`;
               return `<tr class="${isLong ? 'attr-row-long' : ''}">${keyCell}${valCell}</tr>`;
             }).join('')}
           </table>
         </div>`
      : '<div class="attrs-empty">No attributes</div>';

    return `
      <div class="right-panel-span-name">${esc(node.name)}</div>
      <div class="span-meta-grid">${metaHtml}</div>
      ${contentHtml}
      ${attrsHtml}
    `;
  }

  /** @param {unknown} v @returns {string} */
  function fmtAttr(v) {
    if (v === null || v === undefined) { return ''; }
    if (typeof v === 'object')         { return JSON.stringify(v); }
    return String(v);
  }

  // ── gen_ai content rendering ──────────────────────────────────────────────────
  // OTel GenAI semantic-convention attributes carrying prompt/response/tool
  // content (populated when the agent host has captureContent enabled). These
  // are rendered as a readable conversation and excluded from the raw table.
  const GENAI_CONTENT_KEYS = new Set([
    'gen_ai.system_instructions',
    'gen_ai.input.messages',
    'gen_ai.output.messages',
    'gen_ai.tool.call.arguments',
    'gen_ai.tool.call.result',
  ]);

  /** @param {unknown} s @returns {any} */
  function tryParseJson(s) {
    if (typeof s !== 'string') { return s; }
    try { return JSON.parse(s); } catch { return undefined; }
  }

  /** Pretty-print a value (parsing JSON strings first) for a code block. @param {unknown} v */
  function prettyJson(v) {
    let val = v;
    if (typeof val === 'string') {
      const parsed = tryParseJson(val);
      if (parsed === undefined) { return val; }
      val = parsed;
    }
    try { return JSON.stringify(val, null, 2); } catch { return String(val); }
  }

  /** Render one message part ({type, ...}) from a gen_ai message. @param {any} part @param {Record<string,string>} [toolNames] @param {string} [fallbackToolName] */
  function renderGenaiPart(part, toolNames, fallbackToolName) {
    if (part === null || typeof part !== 'object') {
      return `<div class="genai-part genai-text">${esc(String(part ?? ''))}</div>`;
    }
    switch (part.type) {
      case 'text':
        return `<div class="genai-part genai-text">${esc(part.content ?? part.text ?? '')}</div>`;
      case 'reasoning':
        return `<div class="genai-part genai-reasoning">
          <div class="genai-part-label">✳ reasoning</div>
          <div class="genai-text">${esc(part.content ?? part.text ?? '')}</div>
        </div>`;
      case 'tool_call':
        return `<div class="genai-part genai-toolcall">
          <div class="genai-part-label">Calls tool <span class="genai-toolname">${esc(part.name ?? '')}</span></div>
          <pre class="genai-code">${esc(prettyJson(part.arguments))}</pre>
        </div>`;
      case 'tool_call_response': {
        const respName = (toolNames && part.id != null ? toolNames[part.id] : undefined) || fallbackToolName;
        const nameHtml = respName ? ` <span class="genai-toolname">${esc(respName)}</span>` : '';
        return `<div class="genai-part genai-toolresp">
          <div class="genai-part-label">Result from tool${nameHtml}</div>
          <pre class="genai-code">${esc(typeof part.response === 'string' ? part.response : prettyJson(part.response))}</pre>
        </div>`;
      }
      default:
        return `<pre class="genai-code">${esc(prettyJson(part))}</pre>`;
    }
  }

  /** Render an array of gen_ai messages ([{role, parts, finish_reason}]) as bubbles. @param {any} arr @param {string} [fallbackToolName] */
  function renderGenaiMessages(arr, fallbackToolName) {
    if (!Array.isArray(arr)) { return `<pre class="genai-code">${esc(prettyJson(arr))}</pre>`; }
    // Map tool_call id -> tool name so tool_call_response parts can be labeled
    // with the tool that produced them (responses only carry an id, not a name).
    const toolNames = {};
    for (const msg of arr) {
      if (msg && Array.isArray(msg.parts)) {
        for (const p of msg.parts) {
          if (p && p.type === 'tool_call' && p.id != null && p.name) { toolNames[p.id] = String(p.name); }
        }
      }
    }
    return arr.map(msg => {
      if (msg === null || typeof msg !== 'object') {
        return `<div class="genai-msg"><div class="genai-msg-body genai-text">${esc(String(msg ?? ''))}</div></div>`;
      }
      const role   = String(msg.role ?? 'unknown');
      const parts  = Array.isArray(msg.parts) ? msg.parts : (msg.content != null ? [{ type: 'text', content: msg.content }] : []);
      const body   = parts.map(p => renderGenaiPart(p, toolNames, fallbackToolName)).join('');
      const finish = msg.finish_reason ? `<span class="genai-finish">${esc(String(msg.finish_reason))}</span>` : '';
      return `<div class="genai-msg genai-role-${esc(role)}">
        <div class="genai-msg-role">${esc(role)}${finish}</div>
        <div class="genai-msg-body">${body}</div>
      </div>`;
    }).join('');
  }

  /** A collapsible titled block. @param {string} title @param {string} innerHtml @param {boolean} collapsed */
  function genaiBlock(title, innerHtml, collapsed) {
    return `<div class="genai-block${collapsed ? ' genai-collapsed' : ''}">
      <div class="genai-block-head"><span class="genai-chevron">${collapsed ? '▶' : '▾'}</span>${esc(title)}</div>
      <div class="genai-block-body">${innerHtml}</div>
    </div>`;
  }

  /** Build the readable conversation section from a span's gen_ai.* content attributes. @param {any} node */
  function genaiContentHtml(node) {
    const a = node.attributes ?? {};
    const blocks = [];
    const toolName = a['gen_ai.tool.name'] ? String(a['gen_ai.tool.name']) : '';
    const toolSuffix = toolName ? ` · ${toolName}` : '';

    if (a['gen_ai.system_instructions'] != null) {
      const parsed = tryParseJson(a['gen_ai.system_instructions']);
      const text = Array.isArray(parsed)
        ? parsed.map(p => (p && typeof p === 'object') ? (p.content ?? p.text ?? '') : String(p)).join('\n')
        : String(a['gen_ai.system_instructions']);
      blocks.push(genaiBlock('System instructions', `<div class="genai-prose">${esc(text)}</div>`, true));
    }
    if (a['gen_ai.input.messages'] != null) {
      blocks.push(genaiBlock('Input messages', renderGenaiMessages(tryParseJson(a['gen_ai.input.messages']), toolName), true));
    }
    if (a['gen_ai.tool.call.arguments'] != null) {
      blocks.push(genaiBlock('Tool call' + toolSuffix, `<pre class="genai-code">${esc(prettyJson(a['gen_ai.tool.call.arguments']))}</pre>`, false));
    }
    if (a['gen_ai.tool.call.result'] != null) {
      const r = a['gen_ai.tool.call.result'];
      blocks.push(genaiBlock('Tool result' + toolSuffix, `<pre class="genai-code">${esc(typeof r === 'string' ? r : prettyJson(r))}</pre>`, false));
    }
    if (a['gen_ai.output.messages'] != null) {
      blocks.push(genaiBlock('Output messages', renderGenaiMessages(tryParseJson(a['gen_ai.output.messages']), toolName), true));
    }

    if (!blocks.length) { return ''; }
    return `<div class="genai-section">
      <div class="attrs-title">Conversation</div>
      ${blocks.join('')}
    </div>`;
  }

  // ── Performance ───────────────────────────────────────────────────────────────
  function renderMetrics(/** @type {any} */ data) {
    renderSlowest(data.slowestOperations);
    renderTokens(data.tokenUsage);
    renderTools(data.toolCalls);
    renderSummary(data.summary);
  }

  function renderSlowest(/** @type {any[]} */ ops) {
    const el = $('slowest-ops');
    if (!el) { return; }
    if (!ops.length) {
      el.innerHTML = '<div class="empty-state small">No span data yet.</div>';
      return;
    }
    el.innerHTML = table(
      ['Operation', 'Avg', 'Max', 'Count', 'Errors'],
      ops.map(op => [
        `<span class="name-cell" title="${esc(op.name)}">${esc(op.name)}</span>`,
        fmtMs(op.avgDurationMs),
        fmtMs(op.maxDurationMs),
        String(op.count),
        op.errorCount > 0 ? `<span class="pill pill--err">${op.errorCount}</span>` : '0',
      ]),
      ops.map(op => op.errorCount > 0 ? 'row--error' : ''),
      { capped: true },
    );
  }

  function renderTokens(/** @type {any[]} */ tokens) {
    const el = $('token-usage');
    if (!el) { return; }
    if (!tokens.length) {
      el.innerHTML = '<div class="empty-state small">No token data yet.<br><small>Requires <code>gen_ai.*</code> attributes on spans.</small></div>';
      return;
    }
    el.innerHTML = table(
      ['Model', 'Total', 'Prompt', 'Completion', 'Calls'],
      tokens.map(t => [
        `<span class="name-cell" title="${esc(t.model)}">${esc(t.model)}</span>`,
        fmtNum(t.totalTokens),
        fmtNum(t.promptTokens),
        fmtNum(t.completionTokens),
        String(t.callCount),
      ]),
    );
  }

  function renderTools(/** @type {any[]} */ tools) {
    const el = $('tool-calls');
    if (!el) { return; }
    if (!tools.length) {
      el.innerHTML = '<div class="empty-state small">No tool call data yet.<br><small>Requires <code>gen_ai.tool.name</code> or <code>tool.name</code> attributes on spans.</small></div>';
      return;
    }
    el.innerHTML = table(
      ['Tool', 'Calls', 'Avg', 'Total Time', 'Errors'],
      tools.map(t => [
        `<span class="name-cell" title="${esc(t.toolName)}">${esc(t.toolName)}</span>`,
        String(t.count),
        fmtMs(t.avgDurationMs),
        fmtMs(t.totalDurationMs),
        t.errorCount > 0 ? `<span class="pill pill--err">${t.errorCount}</span>` : '0',
      ]),
      tools.map(t => t.errorCount > 0 ? 'row--error' : ''),
      { capped: true },
    );
  }

  function renderSummary(/** @type {any} */ s) {
    const el = $('summary');
    if (!el) { return; }

    const fmtNum = (/** @type {number} */ n) => n.toLocaleString();

    const fmtMs = (/** @type {number} */ ms) =>
      ms <= 0   ? '–'
      : ms >= 1000 ? `${(ms / 1000).toFixed(1)}s`
      : `${Math.round(ms)}ms`;

    const errClass  = s.errorTraces > 0 ? ' text-err' : '';
    const errorRate = s.totalTraces > 0
      ? `${Math.round(s.errorTraces / s.totalTraces * 100)}%`
      : '–';
      
    // cacheHitRate is computed convention-aware in the engine (-1 when unavailable).
    const totalTokens   = s.inputTokens + s.outputTokens;
    const cacheHitPct   = s.cacheHitRate >= 0
      ? `${Math.round(s.cacheHitRate * 100)}%`
      : '–';

    el.innerHTML = `
      <div class="summary-section">
        <div class="summary-section-lbl">Activity</div>
        <div class="summary-row">
          <div class="summary-item"><span class="summary-val">${s.llmCalls}</span><span class="summary-lbl">LLM Calls</span></div>
          <div class="summary-item"><span class="summary-val">${s.toolCallsTotal}</span><span class="summary-lbl">Tool Calls</span></div>
          <div class="summary-item"><span class="summary-val${errClass}">${errorRate}</span><span class="summary-lbl">Error Rate</span></div>
          <div class="summary-item"><span class="summary-val">${fmtMs(s.p95Ms)}</span><span class="summary-lbl">P95 Latency</span></div>
        </div>
      </div>
      <div class="summary-section">
        <div class="summary-section-lbl">Tokens</div>
        <div class="summary-row summary-row--wide">
          <div class="summary-item"><span class="summary-val">${fmtNum(s.inputTokens)}</span><span class="summary-lbl">Input</span></div>
          <div class="summary-item"><span class="summary-val">${fmtNum(s.outputTokens)}</span><span class="summary-lbl">Output</span></div>
          <div class="summary-item"><span class="summary-val">${fmtNum(totalTokens)}</span><span class="summary-lbl">Total</span></div>
          <div class="summary-item"><span class="summary-val">${fmtNum(s.cachedTokens)}</span><span class="summary-lbl">Cache Hits</span></div>
          <div class="summary-item"><span class="summary-val">${fmtNum(s.cacheCreationTokens)}</span><span class="summary-lbl">Cache Writes</span></div>
          <div class="summary-item"><span class="summary-val">${cacheHitPct}</span><span class="summary-lbl">Cache Hit %</span></div>
        </div>
      </div>
    `;
  }

  // ── Utility / LM API calls (Home) ──────────────────────────────────────────────
  // Standalone vscode.lm calls (title/summary generation, embeddings, suggestions)
  // that are NOT agent turns and are excluded from Sessions (#16). Shown here in
  // aggregate with per-model drill-down to the individual calls.
  let utilityData = /** @type {any} */ ({ totalCalls: 0, totalTokens: 0, avgDurationMs: 0, errorCount: 0, byModel: [], calls: [] });
  const expandedUtilModels = new Set();
  /** How many calls are currently visible per expanded model. Grows by
   *  UTIL_CALLS_PAGE each time "Show more" is clicked; reset when collapsed. */
  const utilVisibleCounts = /** @type {Map<string, number>} */ (new Map());
  const UTIL_CALLS_PAGE = 20;

  function renderUtilityCalls(/** @type {any} */ data) {
    utilityData = data || { totalCalls: 0, totalTokens: 0, avgDurationMs: 0, errorCount: 0, byModel: [], calls: [] };
    const el = $('utility-calls');
    if (!el) { return; }

    if (!utilityData.totalCalls) {
      el.innerHTML = '<div class="empty-state small">No background LM calls yet.<br><small>Standalone <code>vscode.lm</code> calls (title/summary generation, embeddings) with no session id.</small></div>';
      return;
    }

    const s = utilityData;
    const errItem = s.errorCount
      ? `<span class="util-summary-item text-err"><span class="util-summary-val text-err">${s.errorCount}</span> errors</span>`
      : '';
    const summary = `<div class="util-summary">
      <span class="util-summary-item"><span class="util-summary-val">${s.totalCalls.toLocaleString()}</span> calls</span>
      <span class="util-summary-item"><span class="util-summary-val">${fmtNum(s.totalTokens)}</span> tokens</span>
      <span class="util-summary-item">avg <span class="util-summary-val">${fmtMs(s.avgDurationMs)}</span></span>
      ${errItem}
    </div>`;

    const rowsHtml = s.byModel.map((/** @type {any} */ m) => {
      const expanded = expandedUtilModels.has(m.model);
      const head = `<tr class="util-model-row${m.errorCount ? ' row--error' : ''}${expanded ? ' util-model-row--open' : ''}" data-util-model="${esc(m.model)}">
        <td><span class="util-chevron">${expanded ? '▾' : '▸'}</span><span class="util-model-name" title="${esc(m.model)}">${esc(m.model)}</span></td>
        <td>${m.callCount}</td>
        <td>${fmtNum(m.totalTokens)}</td>
        <td>${fmtMs(m.avgDurationMs)}</td>
        <td>${fmtMs(m.maxDurationMs)}</td>
      </tr>`;
      if (!expanded) { return head; }

      // Drill-down: the model's individual calls. Paged to keep the card
      // readable — starts at UTIL_CALLS_PAGE and grows via "Show more".
      const visible   = utilVisibleCounts.get(m.model) ?? UTIL_CALLS_PAGE;
      const allCalls  = s.calls.filter((/** @type {any} */ c) => c.model === m.model);
      const calls     = allCalls.slice(0, visible);
      const items = calls.map((/** @type {any} */ c) => `
        <tr class="util-call-row" data-util-trace="${esc(c.traceId)}" data-util-span="${esc(c.spanId)}" title="Jump to trace">
          <td class="util-call-time">${fmtNano(c.startTimeUnixNano)}${c.hasError ? ' <span class="pill pill--err">err</span>' : ''}</td>
          <td>${fmtNum(c.totalTokens)}</td>
          <td>${fmtMs(c.durationMs)}</td>
          <td class="util-call-open">↗</td>
        </tr>`).join('');
      const remaining = m.callCount - calls.length;
      const more = remaining > 0
        ? `<tr class="util-call-more" data-util-more="${esc(m.model)}" title="Show more calls">
             <td colspan="4">Show ${Math.min(UTIL_CALLS_PAGE, remaining)} more · ${calls.length} of ${m.callCount}</td>
           </tr>`
        : '';
      const detail = `<tr class="util-detail-row"><td colspan="5">
        <table class="data-table util-call-table"><tbody>${items}${more}</tbody></table>
      </td></tr>`;
      return head + detail;
    }).join('');

    el.innerHTML = summary + `<div class="table-scroll"><table class="data-table util-model-table">
      <thead><tr><th>Model</th><th>Calls</th><th>Tokens</th><th>Avg</th><th>Max</th></tr></thead>
      <tbody>${rowsHtml}</tbody></table></div>`;
  }

  // Delegated interactions for the utility card: toggle a model's drill-down,
  // or jump to an individual call's trace. The container persists across
  // re-renders (innerHTML is replaced, not the element), so bind once.
  $('utility-calls')?.addEventListener('click', e => {
    const target = /** @type {HTMLElement} */ (e.target);
    const callRow = target?.closest('[data-util-trace]');
    if (callRow) {
      const traceId = /** @type {HTMLElement} */ (callRow).dataset['utilTrace'];
      const spanId  = /** @type {HTMLElement} */ (callRow).dataset['utilSpan'] || null;
      if (traceId) { navigateToTrace(traceId, spanId); }
      return;
    }
    const moreRow = target?.closest('[data-util-more]');
    if (moreRow) {
      const model = /** @type {HTMLElement} */ (moreRow).dataset['utilMore'] ?? '';
      const current = utilVisibleCounts.get(model) ?? UTIL_CALLS_PAGE;
      utilVisibleCounts.set(model, current + UTIL_CALLS_PAGE);
      renderUtilityCalls(utilityData);
      return;
    }
    const modelRow = target?.closest('[data-util-model]');
    if (modelRow) {
      const model = /** @type {HTMLElement} */ (modelRow).dataset['utilModel'] ?? '';
      if (expandedUtilModels.has(model)) {
        expandedUtilModels.delete(model);
        utilVisibleCounts.delete(model); // reset paging so re-expand starts fresh
      } else {
        expandedUtilModels.add(model);
      }
      renderUtilityCalls(utilityData);
    }
  });

  // ── Logs ──────────────────────────────────────────────────────────────────────
  function renderLogs(/** @type {any[]} */ logs) {
    if (!logsList) { return; }
    currentLogs = logs;
    if (!logs.length) {
      logsList.innerHTML = '<div class="empty-state">No logs match the current filter.</div>';
      return;
    }
    logsList.innerHTML = logs.map((log, i) => {
      const levelClass = severityClass(log.severityNumber);
      const ts         = fmtNano(log.timestampUnixNano);
      const isSelected = i === selectedLogIdx;
      return `
        <div class="log-row log-row--${levelClass}${isSelected ? ' log-row--selected' : ''}" data-log-idx="${i}" style="cursor:pointer">
          <span class="log-ts">${ts}</span>
          <span class="log-svc">${esc(log.serviceName)}</span>
          <span class="log-body">${esc(log.body)}</span>
        </div>
      `;
    }).join('');
  }

  // Log row click → show detail panel
  logsList?.addEventListener('click', e => {
    const row = /** @type {HTMLElement} */ (e.target)?.closest('[data-log-idx]');
    if (!row || !logDetailPanel) { return; }
    const idx = parseInt(/** @type {HTMLElement} */ (row).dataset['logIdx'] ?? '-1', 10);
    const log = currentLogs[idx];
    if (!log) { return; }

    // Highlight selected row and persist index
    selectedLogIdx = idx;
    logsList.querySelectorAll('.log-row').forEach(r => r.classList.remove('log-row--selected'));
    row.classList.add('log-row--selected');

    logDetailPanel.innerHTML = `
      <div class="span-detail-panel-header">Log Details</div>
      ${logDetailHtml(log)}
    `;
  });

  // Toggle long attribute values in log detail panel (delegated)
  logDetailPanel?.addEventListener('click', e => {
    const target = /** @type {HTMLElement} */ (e.target);

    // Trace/span deeplink
    const deeplink = target?.closest('.trace-deeplink');
    if (deeplink) {
      const traceId = /** @type {HTMLElement} */ (deeplink).dataset['traceid'];
      const spanId  = /** @type {HTMLElement} */ (deeplink).dataset['spanid'] ?? null;
      if (traceId) { navigateToTrace(traceId, spanId); }
      return;
    }

    // Collapsible long attribute
    const row = target?.closest('.attr-row-long');
    if (!row) { return; }
    const textEl  = row.querySelector('.attr-val-text');
    const chevron = row.querySelector('.attr-chevron');
    if (!textEl) { return; }
    const collapsed = textEl.classList.toggle('collapsed');
    if (chevron) { chevron.textContent = collapsed ? '▶' : '▾'; }
  });

  /** @param {any} log @returns {string} */
  function logDetailHtml(log) {
    const levelText  = (log.severityText || severityLabel(log.severityNumber)).toUpperCase();
    const levelClass = severityClass(log.severityNumber);

    const metaHtml = [
      ['Timestamp', `<span class="mono">${fmtNano(log.timestampUnixNano)}</span>`],
      ['Severity',  `<span class="log-level log-level--${levelClass}">${levelText}</span> <span class="text-muted">(${log.severityNumber})</span>`],
      ['Service',   esc(log.serviceName)],
      ...(log.traceId  ? [['Trace ID',  `<button class="trace-deeplink" data-traceid="${esc(log.traceId)}" title="Jump to trace">${esc(log.traceId)} ↗</button>`]]  : []),
      ...(log.spanId   ? [['Span ID',   log.traceId
        ? `<button class="trace-deeplink" data-traceid="${esc(log.traceId)}" data-spanid="${esc(log.spanId)}" title="Jump to span">${esc(log.spanId)} ↗</button>`
        : `<span class="mono selectable">${esc(log.spanId)}</span>`]]  : []),
    ].map(([k, v]) => `<div class="meta-key">${k}</div><div class="meta-val">${v}</div>`).join('');

    const bodyHtml = `
      <div class="attrs-section">
        <div class="attrs-title">Message</div>
        <pre class="log-detail-body">${esc(log.body)}</pre>
      </div>`;

    const attrEntries = Object.entries(log.attributes ?? {});
    const LONG_THRESHOLD = 120;
    const attrsHtml = attrEntries.length > 0
      ? `<div class="attrs-section">
           <div class="attrs-title">Attributes (${attrEntries.length})</div>
           <table class="attrs-table">
             ${attrEntries.map(([k, v]) => {
               const text = fmtAttr(v);
               const isLong = text.length > LONG_THRESHOLD;
               const keyCell = isLong
                 ? `<td class="attr-key"><span class="attr-chevron">▶</span>${esc(k)}</td>`
                 : `<td class="attr-key">${esc(k)}</td>`;
               const valCell = isLong
                 ? `<td class="attr-val"><span class="attr-val-text collapsed">${esc(text)}</span></td>`
                 : `<td class="attr-val"><span class="attr-val-text">${esc(text)}</span></td>`;
               return `<tr class="${isLong ? 'attr-row-long' : ''}">${keyCell}${valCell}</tr>`;
             }).join('')}
           </table>
         </div>`
      : '<div class="attrs-empty">No attributes</div>';

    return `
      <div class="log-detail-content">
        <div class="span-meta-grid">${metaHtml}</div>
        ${bodyHtml}
        ${attrsHtml}
      </div>
    `;
  }

  // ── Metrics ───────────────────────────────────────────────────────────────────
  const METRIC_ICON = { histogram: '📊', sum: '#️⃣', gauge: '📈' };

  function renderMetricInstruments(/** @type {any[]} */ instruments) {
    currentInstruments = instruments || [];
    renderMetricList();
  }

  /** Render the (optionally filtered) instrument list in the left rail. */
  function renderMetricList() {
    if (!metricsList) { return; }
    if (!currentInstruments.length) {
      metricsList.innerHTML = '<div class="empty-state">No metrics yet.<br><small>Ingested OTLP metrics appear here.</small></div>';
      return;
    }
    const q = (metricFilter?.value || '').trim().toLowerCase();
    const items = q
      ? currentInstruments.filter(i => i.name.toLowerCase().includes(q) || i.serviceName.toLowerCase().includes(q))
      : currentInstruments;

    if (!items.length) {
      metricsList.innerHTML = '<div class="empty-state small">No metrics match the filter.</div>';
      return;
    }

    // Group by service for readability.
    /** @type {Map<string, any[]>} */
    const byService = new Map();
    for (const i of items) {
      if (!byService.has(i.serviceName)) { byService.set(i.serviceName, []); }
      byService.get(i.serviceName).push(i);
    }

    let html = '';
    for (const [svc, list] of byService) {
      html += `<div class="metric-group-hdr">${esc(svc || 'unknown')}</div>`;
      for (const i of list) {
        const key    = `${i.name}|${i.serviceName}`;
        const active = key === selectedMetricKey ? ' active' : '';
        const icon   = METRIC_ICON[i.metricType] || '•';
        const unit   = i.unit ? `<span class="metric-unit">${esc(i.unit)}</span>` : '';
        html += `
          <div class="metric-row${active}" data-name="${esc(i.name)}" data-service="${esc(i.serviceName)}" title="${esc(i.name)}">
            <span class="metric-icon" title="${esc(i.metricType)}">${icon}</span>
            <span class="metric-name">${esc(i.name)}${unit}</span>
            <span class="metric-count">${fmtNum(i.seriesCount)} series</span>
          </div>`;
      }
    }
    metricsList.innerHTML = html;

    metricsList.querySelectorAll('.metric-row').forEach(row => {
      row.addEventListener('click', () => {
        const el = /** @type {HTMLElement} */ (row);
        selectMetric(el.dataset.name || '', el.dataset.service || '');
      });
    });
  }

  function selectMetric(/** @type {string} */ name, /** @type {string} */ service) {
    selectedMetricKey = `${name}|${service}`;
    metricsList?.querySelectorAll('.metric-row').forEach(r => {
      const el = /** @type {HTMLElement} */ (r);
      r.classList.toggle('active', `${el.dataset.name}|${el.dataset.service}` === selectedMetricKey);
    });
    if (metricDetailPanel) {
      metricDetailPanel.innerHTML = '<div class="span-detail-placeholder">Loading…</div>';
    }
    vscode.postMessage({ type: 'getMetricDetail', name, serviceName: service });
  }

  function renderMetricDetail(/** @type {any} */ d) {
    if (!metricDetailPanel) { return; }
    // Ignore late responses for a metric the user has navigated away from.
    if (selectedMetricKey && `${d.name}|${d.serviceName}` !== selectedMetricKey) { return; }

    const isHist = d.metricType === 'histogram';
    const u      = d.unit ? ` <span class="metric-unit">${esc(d.unit)}</span>` : '';

    /** @param {string} label @param {string} val */
    const card = (label, val) =>
      `<div class="summary-item"><span class="summary-val">${val}</span><span class="summary-lbl">${label}</span></div>`;

    const stats = d.stats;
    let cards = '';
    cards += card('Series', fmtNum(stats.seriesCount));
    if (isHist) {
      cards += card('Count', fmtNum(stats.totalCount));
      cards += card('Sum', fmtMetricVal(stats.sum));
      cards += card('Avg', fmtMetricVal(stats.avg));
      cards += card('Min', fmtMetricVal(stats.min));
      cards += card('Max', fmtMetricVal(stats.max));
    } else {
      cards += card('Total', fmtMetricVal(stats.total));
    }

    const chart = buildSparkline(d.series);
    const cumulativeNote = d.isCumulative
      ? '<span class="metric-note" title="Copilot metrics are cumulative — values are running totals; rate/delta views come later.">cumulative</span>'
      : '';

    let dims = '';
    if (d.dimensions && d.dimensions.length) {
      dims = d.dimensions.map((/** @type {any} */ dim) => {
        const rows = dim.values.map((/** @type {any} */ v) => [
          `<span class="name-cell" title="${esc(v.value)}">${esc(v.value)}</span>`,
          fmtNum(v.count),
        ]);
        return `<div class="metric-dim">
            <div class="metric-dim-hdr">${esc(dim.key)}</div>
            ${table(['Value', 'Count'], rows)}
          </div>`;
      }).join('');
    } else {
      dims = '<div class="empty-state small">No attribute dimensions.</div>';
    }

    metricDetailPanel.innerHTML = `
      <div class="metric-detail-content">
        <div class="metric-detail-title">
          <span class="metric-icon">${METRIC_ICON[d.metricType] || '•'}</span>
          <span class="metric-detail-name">${esc(d.name)}${u}</span>
          ${cumulativeNote}
        </div>
        <div class="metric-detail-sub">${esc(d.serviceName)} · ${esc(d.metricType)}</div>

        <div class="summary-section">
          <div class="summary-row">${cards}</div>
        </div>

        <div class="metric-chart-section">
          <div class="metric-section-lbl">Values over time${d.isCumulative ? ' (cumulative)' : ''}</div>
          ${chart}
        </div>

        <div class="metric-dims-section">
          <div class="metric-section-lbl">Breakdown by attribute</div>
          ${dims}
        </div>
      </div>`;
  }

  /** Format a metric value compactly (whole numbers vs fractional). */
  function fmtMetricVal(/** @type {number} */ n) {
    if (n === 0) { return '0'; }
    if (Math.abs(n) >= 1000) { return fmtNum(n); }
    if (Number.isInteger(n)) { return String(n); }
    return n.toFixed(Math.abs(n) < 1 ? 3 : 2);
  }

  /** Hand-rolled inline SVG line chart (no external chart lib under CSP). */
  function buildSparkline(/** @type {{t:number,value:number}[]} */ series) {
    if (!series || series.length < 2) {
      return '<div class="empty-state small">Not enough data points to chart.</div>';
    }
    const W = 640, H = 160, padL = 8, padR = 8, padT = 12, padB = 20;
    const xs = series.map(p => p.t);
    const ys = series.map(p => p.value);
    const minX = Math.min(...xs), maxX = Math.max(...xs);
    const minY = Math.min(...ys), maxY = Math.max(...ys);
    const spanX = (maxX - minX) || 1;
    const spanY = (maxY - minY) || 1;

    const px = (/** @type {number} */ x) => padL + ((x - minX) / spanX) * (W - padL - padR);
    const py = (/** @type {number} */ y) => (H - padB) - ((y - minY) / spanY) * (H - padT - padB);

    const pts  = series.map(p => `${px(p.t).toFixed(1)},${py(p.value).toFixed(1)}`);
    const line = pts.join(' ');
    const area = `${padL},${H - padB} ${line} ${(W - padR)},${H - padB}`;

    const fmtT = (/** @type {number} */ ms) => {
      const dt = new Date(ms);
      const pad = (/** @type {number} */ n) => String(n).padStart(2, '0');
      return `${pad(dt.getMonth() + 1)}/${pad(dt.getDate())} ${pad(dt.getHours())}:${pad(dt.getMinutes())}`;
    };

    return `
      <svg class="metric-chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img">
        <polyline class="metric-chart-area" points="${area}" />
        <polyline class="metric-chart-line" points="${line}" />
      </svg>
      <div class="metric-chart-axis">
        <span>${esc(fmtMetricVal(maxY))}</span>
        <span class="metric-chart-x">${esc(fmtT(minX))} → ${esc(fmtT(maxX))}</span>
        <span>${esc(fmtMetricVal(minY))}</span>
      </div>`;
  }

  // ── Helpers ───────────────────────────────────────────────────────────────────
  /** @param {string} s */
  function esc(s) {
    return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  /** @param {number} ms */
  function fmtMs(ms) {
    if (ms >= 60_000) { return `${(ms / 60_000).toFixed(1)}m`; }
    if (ms >= 1_000)  { return `${(ms / 1_000).toFixed(2)}s`; }
    if (ms >= 1)      { return `${ms.toFixed(1)}ms`; }
    return `${(ms * 1000).toFixed(0)}µs`;
  }

  /** @param {number} n */
  function fmtNum(n) {
    if (n >= 1_000_000) { return `${(n / 1_000_000).toFixed(1)}M`; }
    if (n >= 1_000)     { return `${(n / 1_000).toFixed(1)}K`; }
    return String(n);
  }

  /** @param {string} nanos */
  function fmtNano(nanos) {
    try {
      const ms = Number(BigInt(nanos) / 1_000_000n);
      const d = new Date(ms);
      const pad = (/** @type {number} */ n, /** @type {number} */ w = 2) => String(n).padStart(w, '0');
      return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    } catch { return nanos; }
  }

  const SPAN_KIND = ['?', 'INT', 'SRV', 'CLI', 'PROD', 'CONS'];

  /** @param {number} n */
  function severityLabel(n) {
    if (n >= 21) { return 'FATAL'; }
    if (n >= 17) { return 'ERROR'; }
    if (n >= 13) { return 'WARN'; }
    if (n >= 9)  { return 'INFO'; }
    if (n >= 5)  { return 'DEBUG'; }
    if (n >= 1)  { return 'TRACE'; }
    return 'UNSPECIFIED';
  }

  /** @param {number} n */
  function severityClass(n) {
    if (n >= 17) { return 'error'; }
    if (n >= 13) { return 'warn'; }
    if (n >= 9)  { return 'info'; }
    if (n >= 5)  { return 'debug'; }
    if (n >= 1)  { return 'trace'; }
    return 'unspecified';
  }

  /**
   * @param {string[]}   headers
   * @param {string[][]} rows
   * @param {string[]}   [rowClasses]
   */
  function table(headers, rows, rowClasses = [], opts = {}) {
    const ths = headers.map(h => `<th>${h}</th>`).join('');
    const trs = rows.map((cells, i) => {
      const cls = rowClasses[i] ? ` class="${rowClasses[i]}"` : '';
      return `<tr${cls}>${cells.map(c => `<td>${c}</td>`).join('')}</tr>`;
    }).join('');
    // `capped` keeps the visible viewport to ~10 rows with a sticky header and
    // scrolls the rest, so long lists don't stretch the card indefinitely.
    const scrollCls = opts.capped ? ' table-scroll--capped' : '';
    return `<div class="table-scroll${scrollCls}"><table class="data-table"><thead><tr>${ths}</tr></thead><tbody>${trs}</tbody></table></div>`;
  }

  // ── Boot ──────────────────────────────────────────────────────────────────────
  renderChatSelection();
  vscode.postMessage({ type: 'ready' });
  // Load the default view (Home). A sidebar click will switchTab to another view
  // once the webview reports 'ready' (the extension queues it if needed).
  loadCurrentTab();
}());
