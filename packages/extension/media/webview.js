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
  /** @type {Map<string, any>} - key: sessionId, value: session row data */
  const selectedSessions = new Map();

  // ── Elements ─────────────────────────────────────────────────────────────────
  const $ = (/** @type {string} */ id) => document.getElementById(id);

  const statusBadge    = $('status-badge');
  const refreshBtn     = $('refresh-btn');
  const clearBtn       = $('clear-btn');
  const tracesList     = $('traces-list');
  // The busy indicator lives on the scroll container so it covers both the
  // sticky search box and the stale rows below it.
  const tracesLeft     = tracesList?.closest('.traces-left');
  // The chat-context tray is rendered once per tab that can add to it (traces and
  // sessions), so every instance is driven together rather than a single element.
  const chatSelectionPanels = /** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll('.chat-selection-panel'));
  const chatSelectionCounts = /** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll('.chat-selection-count'));
  const chatSelectionLists  = /** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll('.chat-selection-list'));
  const chatSelectionClears = /** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll('.chat-selection-clear-btn'));
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
  const metricServiceFilterBtn      = $('metric-service-filter-btn');
  const metricServiceFilterDropdown = $('metric-service-filter-dropdown');
  const metricRangeFilterBtn        = $('metric-range-filter-btn');
  const metricRangeFilterDropdown   = $('metric-range-filter-dropdown');

  // Sessions tab elements
  const sessionsListView   = $('sessions-list-view');
  const sessionDetailView  = $('session-detail-view');
  const sessionsList       = $('sessions-list');
  const sessionSummary     = $('session-summary');
  const sessionTracesList  = $('session-traces-list');
  const sessionTracesLeft  = sessionTracesList?.closest('.traces-left');
  const sessionTraceSearch = /** @type {HTMLInputElement} */ ($('session-trace-search'));
  const sessionBackBtn     = $('session-back-btn');
  const logsPanel          = $('logs-panel');

  /** The final host response expected for a user-initiated refresh. */
  let refreshExpectedType = null;
  let refreshStartedAt = 0;
  let refreshStateTimer = null;

  /** @type {string} currently selected service filter */
  let selectedService = '';
  /** @type {'desc'|'asc'} */
  let timeSortOrder = 'desc';
  /** @type {string} currently selected log service filter */
  let selectedLogService = '';
  /** @type {'desc'|'asc'} */
  let logTimeSortOrder = 'desc';

  let errorsOnly = false;
  // Session conversation state: captured model turns grouped by trace id, plus
  // the session's trace metadata, so selecting a trace can render its transcript
  // in the detail pane (Option 2). Populated on the sessionMessages message.
  /** @type {Map<string, any[]>} */
  let sessionMessagesByTrace = new Map();
  /** @type {Map<string, any>} */
  let sessionTraceMap = new Map();
  let sessionMessagesReady = false;
  /** @type {string|null} trace whose conversation is currently shown in the detail pane */
  let selectedConvTraceId = null;
  /** @type {any[]} */
  let currentInstruments = [];
  /** Currently selected metric instrument key (name|service), or null. */
  let selectedMetricKey = null;
  /** Metrics tab: exact service name to show, or '' for all. */
  let selectedMetricService = '';
  /** Metrics tab: active time window as a `METRIC_RANGES` key. '' = all time. */
  let selectedMetricRange = '';
  /** @type {any[]} */
  let currentSessions = [];
  /** Currently selected session id (null = showing the list). */
  let selectedSessionId = null;
  /** Session to open after the Sessions list finishes loading. */
  let pendingSessionId = null;
  /** Trace to focus after the selected session's trace list finishes loading. */
  let pendingSessionTraceId = null;
  /** @type {any[]} */
  let currentLogs = [];
  /** Index of the currently selected log row (-1 = none) */
  let selectedLogIdx = -1;
  /** Pending deeplink: after navigating to traces, auto-expand this trace and highlight this span */
  /** @type {{ traceId: string, spanId: string | null } | null} */
  let pendingDeeplink = null;
  /** @type {Map<string, any>} */
  let traceDataMap = new Map();
  /** @type {Map<string, any[]>} Search hit locations for the current trace list, keyed by traceId. */
  let traceMatchMap = new Map();
  /** @type {any} */
  let currentSpanNode = null;
  /** The trace search term currently applied, used to highlight matches in
   *  the trace list, span waterfall, and span detail panel so it's obvious
   *  *where* a search term matched (not just that the trace was kept). */
  let activeTraceSearchTerm = '';

  // ── Tab switching ─────────────────────────────────────────────────────────────
  /** Pending debounced Home metrics fetch (cancelled if you leave Home first). */
  let homeFetchTimer = null;

  /** Wrap fn so rapid calls (e.g. keystrokes) only run it once the caller has
   *  been quiet for `wait` ms — used so typing a search term queries once per
   *  pause instead of once per character. `.flush()` runs it immediately
   *  (used for Enter, so it doesn't feel laggy) and cancels any pending call. */
  function debounce(/** @type {(...args:any[])=>void} */ fn, /** @type {number} */ wait) {
    let timer = null;
    /** @type {any} */
    const debounced = (...args) => {
      if (timer) { clearTimeout(timer); }
      timer = setTimeout(() => { timer = null; fn(...args); }, wait);
    };
    debounced.flush = (...args) => {
      if (timer) { clearTimeout(timer); timer = null; }
      fn(...args);
    };
    return debounced;
  }

  /** Activate a top-level panel and load its data. Driven by the native
   *  activity-bar sidebar via the 'switchTab' message from the extension host. */
  function switchTab(/** @type {string} */ name, /** @type {boolean} */ fromHost = false) {
    if (!name) { return; }
    if (name !== activeTab && (refreshExpectedType || refreshStateTimer)) {
      resetRefreshState();
    }
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
    else if (activeTab === 'metrics')     { fetchMetricInstruments(); }
    else if (activeTab === 'sessions')    { showSessionsList(); vscode.postMessage({ type: 'getSessions' }); }
  }

  /** Switch to Traces tab, filter to the given trace ID, and optionally highlight a span */
  function navigateToTrace(/** @type {string} */ traceId, /** @type {string|null} */ spanId = null) {
    // Set deeplink + search first so switchTab's fetchTraces picks them up.
    pendingDeeplink = { traceId, spanId };
    if (traceSearch) { traceSearch.value = traceId; }
    switchTab('traces');
  }

  /** Switch to the Sessions tab and open a specific session after its list loads. */
  function navigateToSession(/** @type {string} */ sessionId) {
    pendingSessionId = sessionId;
    switchTab('sessions');
  }

  /** Jump to a specific span from a search match-row, without leaving the
   *  current tab or touching the search box (unlike navigateToTrace). Expands
   *  the trace's waterfall if it's collapsed and reuses renderSpans' existing
   *  deeplink-consuming logic to scroll to, select, and show detail for the span. */
  function jumpToSpanInTrace(/** @type {string} */ traceId, /** @type {string} */ spanId) {
    pendingDeeplink = { traceId, spanId };
    const isSessions = activeTab === 'sessions';
    const prefix      = isSessions ? 'ssc-' : 'sc-';
    const container   = $(`${prefix}${traceId}`);
    const previous    = container?.previousElementSibling;
    const row         = previous?.classList.contains('match-rows')
      ? previous.previousElementSibling
      : previous;
    if (isSessions && row) {
      sessionTracesList?.querySelectorAll('.trace-row--active').forEach(r => r.classList.remove('trace-row--active'));
      row.classList.add('trace-row--active');
    }
    if (container && container.style.display === 'none') {
      expandedTraces.add(traceId);
      container.style.display = 'block';
      row?.classList.remove('collapsed');
      const icon = row?.querySelector('.expand-icon');
      if (icon) { icon.textContent = '▾'; }
    }
    vscode.postMessage({ type: 'getSpans', traceId });
  }

  /** VS Code Search-view-style preview of where a search term matched inside a
   *  trace: one row per hit (span name / id / attribute), with a snippet of
   *  surrounding text and a <mark> around the exact hit. Clicking a row jumps
   *  straight to that span, instead of relying on scanning a tinted waterfall.
   *  Every hit is listed — the list is never capped or collapsed. */
  function matchRowsHtml(/** @type {string} */ traceId) {
    const term    = activeTraceSearchTerm;
    if (!term) { return ''; }
    const matches = traceMatchMap.get(traceId) || [];
    if (!matches.length) { return ''; }

    const rows = matches.map((m, idx) => {
      // SQLite's instr()/substr() count Unicode CODE POINTS, but JS string
      // indices are UTF-16 code units, so slicing m.snippet directly shifts the
      // highlight one position per astral character (emoji are common in
      // captured model output) before the hit. Iterate by code point instead.
      const chars   = Array.from(m.snippet);
      const termLen = Array.from(term).length;
      const pre  = chars.slice(0, m.matchOffset).join('');
      const hit  = chars.slice(m.matchOffset, m.matchOffset + termLen).join('');
      const post = chars.slice(m.matchOffset + termLen).join('');
      const loc  = m.field === 'name'    ? 'name'
                 : m.field === 'spanId'  ? 'span id'
                 : m.field === 'traceId' ? 'trace id'
                 : (m.attrKey || 'attribute');
      return `
        <div class="match-row" data-trace-id="${esc(traceId)}" data-span-id="${esc(m.spanId)}" data-idx="${idx}"
             title="${esc(m.spanName)} — ${esc(loc)}">
          <span class="match-loc">${esc(m.spanName)} <span class="match-loc-field">${esc(loc)}</span></span>
          <span class="match-preview">${m.truncatedStart ? '…' : ''}${esc(pre)}<mark class="search-hit">${esc(hit)}</mark>${esc(post)}${m.truncatedEnd ? '…' : ''}</span>
        </div>
      `;
    }).join('');

    return `
      <div class="match-rows" data-trace-id="${esc(traceId)}">
        ${rows}
      </div>
    `;
  }

  /** Wire click handlers for the match rows just inserted into `root` (a
   *  tracesList/sessionTracesList element, after its innerHTML was set). */
  function bindMatchRowHandlers(/** @type {HTMLElement} */ root) {
    root.querySelectorAll('.match-row').forEach(el => {
      el.addEventListener('click', e => {
        e.stopPropagation();
        const traceId = /** @type {HTMLElement} */ (el).dataset.traceId ?? '';
        const spanId  = /** @type {HTMLElement} */ (el).dataset.spanId ?? '';
        jumpToSpanInTrace(traceId, spanId);
      });
    });
  }

  /** Bumped on every getTraces request; the response echoes it back so a
   *  reply that arrives late (e.g. a broad, slow query outrun by a faster
   *  follow-up as the user keeps typing/narrows the search) can be dropped
   *  instead of overwriting the list with stale, no-longer-matching traces. */
  let tracesRequestSeq = 0;
  let logsRequestSeq = 0;

  /** How many traces the Traces tab shows at once. Previewing search matches
   *  costs far more than listing the traces themselves and scales with the
   *  number of traces previewed, so the list is paged rather than unbounded.
   *  "Show more" adds another page. */
  const TRACE_PAGE_SIZE = 30;
  let traceDisplayLimit = TRACE_PAGE_SIZE;

  /** Whether the last reply reported further traces past the ones shown. */
  let tracesHasMore = false;

  /** Mark the traces list as reloading. The host runs the query synchronously and
   *  can take seconds, during which the list still shows the *previous* result
   *  set — so without this the stale rows read as the answer to the new search.
   *  The webview is a separate process from the host, so the animation keeps
   *  running while the host is blocked. */
  function setTracesBusy(/** @type {boolean} */ busy) {
    tracesLeft?.classList.toggle('is-searching', busy);
    tracesList?.setAttribute('aria-busy', busy ? 'true' : 'false');
  }

  function setSessionTracesBusy(/** @type {boolean} */ busy) {
    sessionTracesLeft?.classList.toggle('is-searching', busy);
    sessionTracesList?.setAttribute('aria-busy', busy ? 'true' : 'false');
  }

  function setLogsBusy(/** @type {boolean} */ busy) {
    logsPanel?.classList.toggle('is-searching', busy);
    logsList?.setAttribute('aria-busy', busy ? 'true' : 'false');
  }

  function requestTraces() {
    activeTraceSearchTerm = traceSearch?.value?.trim() || '';
    vscode.postMessage({
      type:       'getTraces',
      search:     traceSearch?.value  || undefined,
      service:    selectedService     || undefined,
      errorsOnly: errorsOnly || undefined,
      sortOrder:  timeSortOrder,
      limit:      traceDisplayLimit,
      seq:        ++tracesRequestSeq,
    });
  }

  /** Run the current query from the first page. Any change to the search term
   *  or filters starts over, since page 2 of the previous query is meaningless
   *  against a different one. */
  function fetchTraces() {
    traceDisplayLimit = TRACE_PAGE_SIZE;
    setTracesBusy(true);
    requestTraces();
  }

  /** Deliberately does not set the busy state: "Show more" has its own spinner
   *  where the new rows will appear, and the rows already on screen stay valid
   *  and are about to be re-rendered unchanged — so fading them, or sweeping the
   *  search box the user never touched, would point at the wrong thing. */
  function showMoreTraces() {
    traceDisplayLimit += TRACE_PAGE_SIZE;
    requestTraces();
  }

  /** Re-query the open session's traces, filtered by its own search box. Shares
   *  activeTraceSearchTerm with the Traces tab so the waterfall / span detail /
   *  attribute viewer highlight matches the same way (only one tab is live). */
  function fetchSessionTraces() {
    if (!selectedSessionId) { return; }
    activeTraceSearchTerm = sessionTraceSearch?.value?.trim() || '';
    setSessionTracesBusy(true);
    vscode.postMessage({
      type:      'getTraces',
      sessionId: selectedSessionId,
      search:    sessionTraceSearch?.value || undefined,
      sortOrder: 'desc',
      seq:        ++tracesRequestSeq,
    });
  }

  // Typing a search term (e.g. "4.8") fires an 'input' event per character;
  // querying on every one made the trace list flash through "4" → "4." → "4.8"
  // instead of waiting for the user to pause. Enter still runs immediately
  // via .flush(). 300ms mirrors VS Code's own search-box debounce.
  const debouncedFetchTraces        = debounce(fetchTraces, 300);
  const debouncedFetchSessionTraces = debounce(fetchSessionTraces, 300);

  function fetchLogs() {
    setLogsBusy(true);
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
      seq:         ++logsRequestSeq,
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

  const REFRESH_RESPONSE_BY_TAB = {
    home:     'utilityCalls',
    traces:   'traces',
    logs:     'logs',
    metrics:  'metricInstruments',
    sessions: 'sessions',
  };

  function setRefreshContent(/** @type {string} */ icon, /** @type {string} */ label) {
    const iconEl = refreshBtn?.querySelector('.refresh-btn-icon');
    const labelEl = refreshBtn?.querySelector('.refresh-btn-label');
    if (iconEl) { iconEl.textContent = icon; }
    if (labelEl) { labelEl.textContent = label; }
  }

  function beginRefresh() {
    if (!refreshBtn) { return; }
    if (refreshStateTimer) { clearTimeout(refreshStateTimer); refreshStateTimer = null; }
    refreshExpectedType = REFRESH_RESPONSE_BY_TAB[activeTab] ?? null;
    refreshStartedAt = Date.now();
    refreshBtn.classList.remove('is-complete', 'is-failed');
    refreshBtn.classList.add('is-refreshing');
    refreshBtn.setAttribute('aria-busy', 'true');
    refreshBtn.setAttribute('title', 'Refreshing data');
    refreshBtn.disabled = true;
    setRefreshContent('↻', 'Refreshing…');
  }

  function resetRefreshState() {
    if (refreshStateTimer) { clearTimeout(refreshStateTimer); refreshStateTimer = null; }
    refreshExpectedType = null;
    refreshBtn?.classList.remove('is-refreshing', 'is-complete', 'is-failed');
    refreshBtn?.setAttribute('aria-busy', 'false');
    refreshBtn?.setAttribute('title', 'Refresh data');
    if (refreshBtn) { refreshBtn.disabled = false; }
    setRefreshContent('↻', 'Refresh');
  }

  function finishRefresh(/** @type {boolean} */ success) {
    if (!refreshBtn || !refreshExpectedType) { return; }
    refreshExpectedType = null;

    // Keep very fast refreshes visible long enough for the state change to register.
    const delay = Math.max(0, 350 - (Date.now() - refreshStartedAt));
    refreshStateTimer = setTimeout(() => {
      refreshStateTimer = null;
      refreshBtn.classList.remove('is-refreshing');
      refreshBtn.classList.add(success ? 'is-complete' : 'is-failed');
      refreshBtn.setAttribute('aria-busy', 'false');
      refreshBtn.setAttribute('title', success ? 'Data refreshed' : 'Refresh failed');
      refreshBtn.disabled = false;
      setRefreshContent(success ? '✓' : '!', success ? 'Refreshed' : 'Refresh failed');

      refreshStateTimer = setTimeout(() => {
        refreshStateTimer = null;
        refreshBtn.classList.remove('is-complete', 'is-failed');
        refreshBtn.setAttribute('title', 'Refresh data');
        setRefreshContent('↻', 'Refresh');
      }, 1200);
    }, delay);
  }

  refreshBtn?.addEventListener('click', () => {
    // Refresh collapses everything: the list is rebuilt from scratch, so an
    // explicit refresh gives a clean, fully-collapsed view. (Tab switches, by
    // contrast, preserve and repopulate open traces — see the render functions.)
    expandedTraces.clear();
    beginRefresh();
    loadCurrentTab();
  });

  clearBtn?.addEventListener('click', () => {
    vscode.postMessage({ type: 'clearData' });
  });
  chatSelectionClears.forEach(clear => clear.addEventListener('click', () => {
    selectedTraceIds.clear();
    selectedSpans.clear();
    selectedSessions.clear();
    refreshSessionChatButtons();
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
  }));
  chatSelectionLists.forEach(list => list.addEventListener('click', e => {
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
    } else if (kind === 'session') {
      selectedSessions.delete(id);
      refreshSessionChatButtons();
    }

    renderChatSelection();
    syncAllToChat();
  }));

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

  traceSearch?.addEventListener('input', () => debouncedFetchTraces());
  traceSearch?.addEventListener('keydown', e => { if (e.key === 'Enter') { debouncedFetchTraces.flush(); } });
  sessionTraceSearch?.addEventListener('input', () => debouncedFetchSessionTraces());
  sessionTraceSearch?.addEventListener('keydown', e => { if (e.key === 'Enter') { debouncedFetchSessionTraces.flush(); } });
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

  // Metrics service / time-range dropdown toggles. Opening one closes the other,
  // since they sit side by side and would otherwise overlap.
  /** Show/hide a dropdown and keep its trigger's aria-expanded in sync. */
  function setDropdownOpen(/** @type {HTMLElement|null} */ dropdown, /** @type {HTMLElement|null} */ btn, /** @type {boolean} */ open) {
    if (dropdown) { dropdown.style.display = open ? 'block' : 'none'; }
    btn?.setAttribute('aria-expanded', open ? 'true' : 'false');
  }

  metricServiceFilterBtn?.addEventListener('click', e => {
    e.stopPropagation();
    if (!metricServiceFilterDropdown) { return; }
    const isOpen = metricServiceFilterDropdown.style.display !== 'none';
    setDropdownOpen(metricRangeFilterDropdown, metricRangeFilterBtn, false);
    setDropdownOpen(metricServiceFilterDropdown, metricServiceFilterBtn, !isOpen);
  });

  metricRangeFilterBtn?.addEventListener('click', e => {
    e.stopPropagation();
    if (!metricRangeFilterDropdown) { return; }
    const isOpen = metricRangeFilterDropdown.style.display !== 'none';
    setDropdownOpen(metricServiceFilterDropdown, metricServiceFilterBtn, false);
    setDropdownOpen(metricRangeFilterDropdown, metricRangeFilterBtn, !isOpen);
  });

  // Close dropdowns when clicking outside
  document.addEventListener('click', () => {
    if (serviceFilterDropdown)         { serviceFilterDropdown.style.display = 'none'; }
    if (logServiceFilterDropdown)      { logServiceFilterDropdown.style.display = 'none'; }
    setDropdownOpen(metricServiceFilterDropdown, metricServiceFilterBtn, false);
    setDropdownOpen(metricRangeFilterDropdown, metricRangeFilterBtn, false);
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

  /**
   * Return every master-detail right-hand pane to its empty placeholder and drop
   * the selection state that drives it. Used after the store is cleared, since the
   * spans/metrics/logs those panes describe no longer exist.
   */
  function resetDetailPanels() {
    const placeholder = (/** @type {string} */ text) =>
      `<div class="span-detail-placeholder">${text}</div>`;

    const spanDetail = $('span-detail-panel');
    if (spanDetail) { spanDetail.innerHTML = placeholder('← Expand a trace and click a span to view its details'); }

    const sessionDetail = $('session-span-detail');
    if (sessionDetail) { sessionDetail.innerHTML = placeholder('← Select a trace to read its conversation, or expand it and click a span for span details'); }

    if (metricDetailPanel) { metricDetailPanel.innerHTML = placeholder('← Select a metric to view its details'); }
    if (logDetailPanel)    { logDetailPanel.innerHTML    = placeholder('← Click a log entry to view its details'); }

    selectedMetricKey = null;
    selectedConvTraceId = null;
    sessionMessagesByTrace = new Map();
    sessionTraceMap = new Map();
    sessionMessagesReady = false;
    showSessionsList();
  }

  window.addEventListener('message', event => {
    dispatchExtensionMessage(event.data);
  });

  /** Handles one extension→webview message. Wrapped so a bug in a renderer
   *  (e.g. an unexpected shape from a failed query) surfaces as a visible
   *  error instead of silently leaving a "loading…" placeholder stuck forever. */
  function dispatchExtensionMessage(/** @type {any} */ msg) {
    try {
      dispatchExtensionMessageInner(msg);
    } catch (err) {
      console.error(err);
      renderRequestError(msg, err instanceof Error ? err.message : String(err));
    }
  }

  function dispatchExtensionMessageInner(/** @type {any} */ msg) {
    switch (msg.type) {
      case 'status':   renderStatus(msg);                    break;
      case 'traces':
        // Drop replies for a request that's no longer the latest — otherwise
        // an older, broader query that happened to take longer could arrive
        // after a newer, narrower one and repopulate the list with traces
        // that no longer match what's actually in the search box.
        // Deliberately after the staleness guard: a superseded reply means a newer
        // query is still running, so the list should keep reading as busy.
        if (typeof msg.seq === 'number' && msg.seq < tracesRequestSeq) { return; }
        if (msg.sessionId) {
          setSessionTracesBusy(false);
          if (msg.sessionId !== selectedSessionId) { return; }
        } else {
          setTracesBusy(false);
        }
        traceMatchMap = new Map();
        for (const m of (msg.matches || [])) {
          const list = traceMatchMap.get(m.traceId);
          if (list) { list.push(m); } else { traceMatchMap.set(m.traceId, [m]); }
        }
        if (msg.sessionId) { renderSessionTraces(msg.data); }
        else { tracesHasMore = !!msg.hasMore; renderTraces(msg.data); }
        break;
      case 'services':    renderServices(msg.data);              break;
      case 'logServices': renderLogServices(msg.data);           break;
      case 'sessions': renderSessions(msg.data);             break;
      case 'spans':    renderSpans(msg.traceId, msg.data);   break;
      case 'sessionMessages': onSessionMessages(msg.sessionId, msg.data); break;
      case 'metrics': renderMetrics(msg.data);              break;
      case 'utilityCalls': renderUtilityCalls(msg.data);    break;
      case 'metricInstruments': renderMetricInstruments(msg.data); break;
      case 'metricDetail':      renderMetricDetail(msg.data);      break;
      case 'logs':
        if (typeof msg.seq === 'number' && msg.seq < logsRequestSeq) { return; }
        setLogsBusy(false);
        renderLogs(msg.data);
        break;
      case 'cleared':
        selectedTraceIds.clear();
        selectedSpans.clear();
        selectedSessions.clear();
        expandedTraces.clear();
        traceDataMap = new Map();
        resetDetailPanels();
        renderChatSelection();
        vscode.postMessage({ type: 'getServices' });
        loadCurrentTab();
        break;
      case 'navigateToTrace': navigateToTrace(msg.traceId, msg.spanId ?? null); break;
      case 'navigateToSession': navigateToSession(msg.sessionId); break;
      case 'switchTab': switchTab(msg.tab, true); break;
      case 'error': renderRequestError(msg, msg.message); break;
    }
    if (msg.type === refreshExpectedType) { finishRefresh(true); }
  }

  /** Replace any still-pending "loading…" placeholders with a visible failure
   *  message, so a query error doesn't just look like an infinite spinner. */
  function renderRequestError(/** @type {any} */ msg, /** @type {string} */ message) {
    finishRefresh(false);
    setTracesBusy(false);
    setSessionTracesBusy(false);
    setLogsBusy(false);
    const els = msg?.traceId
      ? [$(`sc-${msg.traceId}`), $(`ssc-${msg.traceId}`)].filter(Boolean)
      : [...document.querySelectorAll('.loading-row')];
    for (const el of els) {
      const loadingRows = el.classList.contains('loading-row') ? [el] : [...el.querySelectorAll('.loading-row')];
      for (const row of loadingRows) {
        row.classList.add('error-row');
        row.textContent = `Failed to load: ${message}`;
      }
    }
  }


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
    const traces   = [...selectedTraceIds].map(id => traceDataMap.get(id)).filter(Boolean);
    const spans    = [...selectedSpans.values()];
    const sessions = [...selectedSessions.values()];
    vscode.postMessage({ type: 'addItemsToChat', traces, spans, sessions });
  }

  /** @param {string} value @returns {string} */
  function shortId(value) {
    if (!value) { return ''; }
    if (value.length <= 12) { return value; }
    return `${value.slice(0, 6)}…${value.slice(-4)}`;
  }

  function renderChatSelection() {
    if (!chatSelectionPanels.length) { return; }

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
    // Sessions lead: they are the broadest scope, and the others narrow within one.
    const sessionItems = [...selectedSessions.values()].map(s => ({
      kind: 'session',
      id: s.sessionId,
      label: s?.serviceName
        ? `Session: ${s.serviceName} (${shortId(s.sessionId)})`
        : `Session: ${shortId(s.sessionId)}`,
    }));
    const allItems = [...sessionItems, ...traceItems, ...spanItems];

    chatSelectionCounts.forEach(el => { el.textContent = `Chat Context (${allItems.length})`; });
    chatSelectionPanels.forEach(el => el.classList.toggle('chat-selection-panel--empty', allItems.length === 0));

    const html = allItems.length
      ? allItems.map(item => `
      <span class="chat-selection-chip" data-chat-kind="${item.kind}" data-chat-id="${esc(item.id)}">
        <span class="chat-selection-chip-label">${esc(item.label)}</span>
        <button class="chat-selection-chip-remove" title="Remove from chat context" aria-label="Remove from chat context">✕</button>
      </span>
    `).join('')
      : '<span class="chat-selection-empty">No sessions, traces or spans in chat context.</span>';

    chatSelectionLists.forEach(el => { el.innerHTML = html; });
  }

  // ── Sessions ──────────────────────────────────────────────────────────────────
  /**
   * The "+ chat" button for a whole session. A session is the unit worth
   * analyzing — the session tool pulls the turn timeline and errors from one id,
   * so this stays a single reference instead of one per trace.
   * @param {string} sessionId @param {string} [extraClass]
   */
  function sessionChatBtnHtml(sessionId, extraClass) {
    const isSelected = selectedSessions.has(sessionId);
    return `<button class="add-to-chat-btn${extraClass ? ' ' + extraClass : ''}${
      isSelected ? ' add-to-chat-btn--selected' : ''}" data-session-chat="${esc(sessionId)}"
      title="Add the whole session to chat">${isSelected ? '✓ added' : '+ chat'}</button>`;
  }

  /** Add/remove an entire session from the chat context. @param {string} sessionId */
  function toggleSessionInChat(sessionId) {
    if (selectedSessions.has(sessionId)) {
      selectedSessions.delete(sessionId);
    } else {
      selectedSessions.set(sessionId, currentSessions.find(x => x.sessionId === sessionId) || { sessionId });
    }
    refreshSessionChatButtons();
    renderChatSelection();
    syncAllToChat();
  }

  /** Re-sync every rendered session button (list row and detail header) with the selection. */
  function refreshSessionChatButtons() {
    document.querySelectorAll('[data-session-chat]').forEach(btn => {
      const isSelected = selectedSessions.has(/** @type {HTMLElement} */ (btn).dataset.sessionChat ?? '');
      btn.textContent = isSelected ? '✓ added' : '+ chat';
      btn.classList.toggle('add-to-chat-btn--selected', isSelected);
    });
  }

  /**
   * Wires session "+ chat" buttons within a container. The click is stopped from
   * bubbling so it does not also open the session behind it.
   * @param {HTMLElement | null} root
   */
  function bindSessionChatButtons(root) {
    root?.querySelectorAll('[data-session-chat]').forEach(btn => {
      btn.addEventListener('click', e => {
        e.stopPropagation();
        toggleSessionInChat(/** @type {HTMLElement} */ (btn).dataset.sessionChat ?? '');
      });
    });
  }

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
    const targetSessionId = pendingSessionId;
    pendingSessionId = null;
    if (!currentSessions.length) {
      sessionsList.innerHTML = targetSessionId
        ? `<div class="empty-state">Session <code>${esc(targetSessionId)}</code> was not found.</div>`
        : `<div class="empty-state">No sessions yet.<br><small>Agent conversations (Copilot, Claude Code) appear here once telemetry arrives.</small></div>`;
      return;
    }
    sessionsList.innerHTML = currentSessions.map(sessionRowHtml).join('');
    sessionsList.querySelectorAll('.session-row').forEach(row => {
      row.addEventListener('click', () => {
        const id = /** @type {HTMLElement} */ (row).dataset.id ?? '';
        selectSession(id);
      });
    });
    bindSessionChatButtons(sessionsList);
    if (targetSessionId) {
      if (currentSessions.some(s => s.sessionId === targetSessionId)) {
        selectSession(targetSessionId);
      } else {
        sessionsList.insertAdjacentHTML(
          'afterbegin',
          `<div class="empty-state">Session <code>${esc(targetSessionId)}</code> was not found.</div>`,
        );
      }
    }
  }

  /** @param {any} s */
  function sessionRowHtml(s) {
    const models = (s.models || []).join(', ');
    // Prefer the chat title the agent host reported; fall back to the models /
    // service label for harnesses and VS Code builds that don't emit one.
    const label = s.title || models || s.serviceName;
    return `
      <div class="session-row ${s.hasError ? 'row--error' : ''}" data-id="${esc(s.sessionId)}">
        <span class="session-status ${s.hasError ? 'session-status--err' : 'session-status--ok'}" title="${s.hasError ? `Failed — ${Number(s.errorCount ?? 0) || 1} errored span(s)` : 'OK'}"></span>
        <span class="session-cell session-cell--main">${esc(label)}</span>
        <span class="session-cell session-cell--service">${esc(s.serviceName)}</span>
        <span class="session-cell session-cell--ts">${fmtNano(s.startTimeUnixNano)}</span>
        <span class="session-cell session-cell--metric session-cell--traces">${s.traceCount} trace${s.traceCount !== 1 ? 's' : ''}</span>
        <span class="session-cell session-cell--metric session-cell--tokens">${s.totalTokens ? `${fmtNum(s.totalTokens)} tok` : '—'}</span>
        <span class="session-cell session-cell--metric session-cell--dur">${fmtMs(s.durationMs)}</span>
        ${sessionChatBtnHtml(s.sessionId)}
      </div>
    `;
  }

  /** Open a session: render its summary card and fetch its traces. */
  function selectSession(/** @type {string} */ sessionId) {
    selectedSessionId = sessionId;
    pendingSessionTraceId = null;
    const s = currentSessions.find(x => x.sessionId === sessionId);
    showSessionDetail();
    renderSessionSummary(s);
    // Reset conversation state, span-detail pane, and traces list for the session.
    sessionMessagesByTrace = new Map();
    sessionTraceMap = new Map();
    sessionMessagesReady = false;
    selectedConvTraceId = null;
    const detail = $('session-span-detail');
    if (detail) { detail.innerHTML = `<div class="span-detail-placeholder">← Select a trace to read its conversation, or expand it and click a span for span details</div>`; }
    // Each session opens with a clean search; typing re-queries via fetchSessionTraces.
    if (sessionTraceSearch) { sessionTraceSearch.value = ''; }
    activeTraceSearchTerm = '';
    if (sessionTracesList) { sessionTracesList.innerHTML = `<div class="empty-state">Loading traces…</div>`; }
    fetchSessionTraces();
    vscode.postMessage({ type: 'getSessionMessages', sessionId });
  }

  /** @param {any} s */
  function renderSessionSummary(s) {
    if (!sessionSummary) { return; }
    if (!s) { sessionSummary.innerHTML = ''; return; }
    const models = (s.models || []).join(', ') || '—';
    const errorCount = Number(s.errorCount ?? 0);
    const statusChip = s.hasError
      ? `<span class="session-chip session-chip--err">Failed${errorCount > 1 ? ` · ${errorCount} errors` : ''}</span>`
      : `<span class="session-chip session-chip--ok">OK</span>`;
    const stat = (/** @type {string} */ label, /** @type {string} */ value) =>
      `<div class="session-stat"><div class="session-stat-value">${value}</div><div class="session-stat-label">${label}</div></div>`;
    sessionSummary.innerHTML = `
      <div class="session-summary-head">
        ${statusChip}
        ${s.title ? `<span class="session-summary-title">${esc(s.title)}</span>` : ''}
        <span class="session-summary-service">${esc(s.serviceName)}</span>
        <span class="session-summary-id">${esc(s.sessionId)}</span>
        ${sessionChatBtnHtml(s.sessionId, 'add-to-chat-btn--visible')}
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
      ${sessionFailuresHtml(s)}
    `;
    sessionSummary.querySelectorAll('.session-failure-trace').forEach(button => {
      button.addEventListener('click', () => {
        const traceId = /** @type {HTMLElement} */ (button).dataset.traceId ?? '';
        focusSessionTrace(traceId);
      });
    });
    bindSessionChatButtons(sessionSummary);
  }

  /**
   * Every failure in the session, not just the first — a session spans multiple
   * traces and each trace can fail more than once.
   * @param {any} s
   */
  function sessionFailuresHtml(s) {
    if (!s.hasError) { return ''; }
    const failures = /** @type {any[]} */ (s.failures || []);
    if (!failures.length) {
      // Errored spans exist but carry no status message / exception text.
      return `<div class="session-failure"><span class="session-failure-label">Failures</span>`
        + `<span class="session-failure-text">${Number(s.errorCount ?? 0) || 1} errored span(s), no error message reported</span></div>`;
    }
    const label = failures.length === 1 ? 'Failure reason' : `Failure reasons (${failures.length})`;
    const items = failures.map(f => {
      const times = f.count > 1 ? `<span class="session-failure-count">×${f.count}</span>` : '';
      const msg   = f.message ? esc(f.message) : '(no message)';
      return `<li class="session-failure-item">
          <span class="session-failure-text">${esc(f.spanName)}: ${msg}${times}</span>
          <button type="button" class="session-failure-trace" data-trace-id="${esc(f.traceId)}"
                  title="Show trace ${esc(f.traceId)}" aria-label="Show trace ${esc(f.traceId)}">${esc(f.traceId)}</button>
        </li>`;
    }).join('');
    return `<div class="session-failure">
        <span class="session-failure-label">${label}</span>
        <ul class="session-failure-list">${items}</ul>
      </div>`;
  }

  // ── Session conversation transcript ───────────────────────────────────────────
  // Renders a session's captured model turns as a readable chat transcript:
  // deduped user prompts + assistant answers as the hero, with reasoning and
  // tool calls tucked into collapsible toggles/chips. Reuses gen_ai content.

  /** A lightweight collapsible (toggled by the delegated .conv-toggle handler). @param {string} headInner @param {string} detailInner @param {boolean} collapsed @param {string} [extraClass] */
  function convCollapsible(headInner, detailInner, collapsed, extraClass) {
    return `<div class="conv-collapsible ${extraClass || ''} ${collapsed ? 'conv-collapsed' : ''}">
      <div class="conv-toggle">${headInner}</div>
      <div class="conv-detail">${detailInner}</div>
    </div>`;
  }

  /** Flatten one turn's gen_ai.output.messages into hero answer + reasoning + tool calls. @param {string} json */
  function flattenTurn(json) {
    const arr = tryParseJson(json);
    /** @type {{reasoning: string[], toolCalls: any[], answer: string, finish: string, answerRaw?: string}} */
    const out = { reasoning: [], toolCalls: [], answer: '', finish: '' };
    if (!Array.isArray(arr)) { out.answerRaw = json; return out; }
    for (const msg of arr) {
      if (!msg || typeof msg !== 'object') { continue; }
      if (msg.finish_reason) { out.finish = String(msg.finish_reason); }
      const parts = Array.isArray(msg.parts)
        ? msg.parts
        : (msg.content != null ? [{ type: 'text', content: msg.content }] : []);
      for (const p of parts) {
        if (!p || typeof p !== 'object') { if (typeof p === 'string') { out.answer += (out.answer ? '\n' : '') + p; } continue; }
        switch (p.type) {
          case 'text':      out.answer += (out.answer ? '\n' : '') + String(p.content ?? p.text ?? ''); break;
          case 'reasoning': out.reasoning.push(String(p.content ?? p.text ?? '')); break;
          case 'tool_call': out.toolCalls.push({ name: String(p.name ?? 'tool'), args: p.arguments }); break;
          case 'tool_call_response': out.toolCalls.push({ name: null, response: p.response, id: p.id }); break;
          default:          out.toolCalls.push({ name: p.type || 'part', args: p }); break;
        }
      }
    }
    return out;
  }

  /** One tool chip (collapsed): a tool call (arguments) or a tool result
   * (response). Only the kind + tool name show on the chip; the payload stays
   * behind the toggle so long commands don't crowd the transcript.
   * @param {any} tc @param {string} [term] */
  function convToolChip(tc, term) {
    const searchTerm = typeof term === 'string' ? term : '';
    const isResp = tc.response !== undefined;
    const name = tc.name ? highlightTerm(String(tc.name), searchTerm) : '';
    const detailText = tc.args !== undefined
      ? prettyJson(tc.args)
      : (isResp ? (typeof tc.response === 'string' ? tc.response : prettyJson(tc.response)) : '');
    const detail = detailText
      ? `<pre class="genai-code">${highlightTerm(detailText, searchTerm)}</pre>`
      : '<div class="conv-tool-empty">(no arguments)</div>';
    const detailMatches = textMatchesTerm(detailText, searchTerm);
    const head = `<span class="conv-chevron">▸</span><span class="conv-tool-kind">${isResp ? 'result' : 'call'}</span>${
      name ? `<span class="conv-tool-name">${name}</span>` : ''}`;
    return convCollapsible(head, detail, !detailMatches, 'conv-tool');
  }

  /** Render an accessible Codicon avatar for a conversation role. @param {string} role */
  function convAvatar(role) {
    const normalized = role === 'user' || role === 'assistant' || role === 'system' || role === 'tool'
      ? role
      : 'other';
    const icon = {
      user: 'account',
      assistant: 'copilot',
      system: 'settings-gear',
      tool: 'tools',
      other: 'question',
    }[normalized];
    const label = normalized === 'other' ? role : normalized;
    return `<div class="conv-avatar conv-avatar--${normalized}" role="img" aria-label="${esc(label)}" title="${esc(label)}">
      <span class="codicon codicon-${icon}" aria-hidden="true"></span>
    </div>`;
  }

  /** Attributes that make a full-conversation bubble navigate to its source span. @param {any} t */
  function convSourceAttrs(t) {
    if (!t?.traceId || !t?.spanId) { return ''; }
    return `data-conv-trace-id="${esc(String(t.traceId))}" data-conv-span-id="${esc(String(t.spanId))}" ` +
      `role="button" tabindex="0" aria-label="View source span ${esc(String(t.spanId))}" title="View source span"`;
  }

  /** A user prompt row. @param {string} text @param {any} t */
  function convUserRow(text, t) {
    return `<div class="conv-turn conv-turn--user">
      ${convAvatar('user')}
      <div class="conv-bubble" ${convSourceAttrs(t)}><div class="conv-answer conv-md">${renderMessageBody(text)}</div></div>
    </div>`;
  }

  /** An assistant turn row: reasoning toggle + tool chips + hero answer. @param {any} t @param {any} flat */
  function convAssistantRow(t, flat) {
    const model = t.model ? esc(String(t.model)) : 'assistant';
    const ts    = fmtNano(t.startTimeUnixNano);
    const err   = t.hasError ? `<span class="session-chip session-chip--err">error</span>` : '';
    const finish = flat.finish ? `<span class="conv-finish">${esc(flat.finish)}</span>` : '';
    const reasoning = flat.reasoning.length
      ? convCollapsible(
          `<span class="conv-chevron">▸</span><span class="conv-think">Thought for a moment</span>`,
          `<div class="genai-text conv-reason conv-md">${mdToHtml(flat.reasoning.join('\n\n'))}</div>`,
          true, 'conv-reasoning')
      : '';
    const tools = flat.toolCalls.map(convToolChip).join('');
    const answer = flat.answer
      ? `<div class="conv-answer conv-md">${renderMessageBody(flat.answer)}</div>`
      : (flat.toolCalls.length
          ? `<div class="conv-answer conv-answer--muted">(no text response — used tools)</div>`
          : (flat.answerRaw ? `<pre class="genai-code">${esc(flat.answerRaw)}</pre>` : ''));
    return `<div class="conv-turn conv-turn--assistant">
      ${convAvatar('assistant')}
      <div class="conv-bubble" ${convSourceAttrs(t)}>
        <div class="conv-meta"><span class="conv-speaker">${model}</span><span class="conv-time">${ts}</span>${finish}${err}</div>
        ${reasoning}
        ${tools}
        ${answer}
      </div>
    </div>`;
  }

  /** Flatten a single gen_ai message's parts into reasoning/toolCalls/text/finish. @param {any} msg */
  function flattenMsg(msg) {
    /** @type {{reasoning: string[], toolCalls: any[], text: string, finish: string}} */
    const out = { reasoning: [], toolCalls: [], text: '', finish: '' };
    if (msg && msg.finish_reason) { out.finish = String(msg.finish_reason); }
    const parts = Array.isArray(msg && msg.parts)
      ? msg.parts
      : (msg && msg.content != null ? [{ type: 'text', content: msg.content }] : []);
    for (const p of parts) {
      if (!p || typeof p !== 'object') { if (typeof p === 'string') { out.text += (out.text ? '\n' : '') + p; } continue; }
      switch (p.type) {
        case 'text':      out.text += (out.text ? '\n' : '') + String(p.content ?? p.text ?? ''); break;
        case 'reasoning': out.reasoning.push(String(p.content ?? p.text ?? '')); break;
        case 'tool_call': out.toolCalls.push({ name: String(p.name ?? 'tool'), args: p.arguments }); break;
        case 'tool_call_response': out.toolCalls.push({ name: null, response: p.response, id: p.id }); break;
        default:          out.toolCalls.push({ name: p.type || 'part', args: p }); break;
      }
    }
    return out;
  }

  /** Render a single gen_ai message ({role, parts}) as a readable transcript row.
   * System prompts and tool payloads are tucked into collapsibles so the thread
   * stays scannable. @param {any} msg @param {Record<string,string>} toolNames
   * @param {string} [term] */
  function convRow(msg, toolNames, term) {
    const searchTerm = term || '';
    if (!msg || typeof msg !== 'object') {
      return `<div class="conv-turn conv-turn--other">${convAvatar('unknown')}<div class="conv-bubble"><div class="conv-answer">${highlightTerm(String(msg ?? ''), searchTerm)}</div></div></div>`;
    }
    const role = String(msg.role ?? 'unknown');
    const flat = flattenMsg(msg);
    const toolsHtml = flat.toolCalls.map(tc => {
      if (tc.name == null && tc.id != null && toolNames[tc.id]) { tc = Object.assign({}, tc, { name: toolNames[tc.id] }); }
      return convToolChip(tc, searchTerm);
    }).join('');

    // System instructions: collapsed by default so they don't dominate the thread.
    if (role === 'system') {
      const detail = `<div class="genai-text conv-sys conv-md">${renderMessageBody(flat.text, searchTerm)}</div>`;
      const head = `<span class="conv-chevron">▸</span><span class="conv-think">System instructions</span>`;
      return `<div class="conv-turn conv-turn--system">
        ${convAvatar('system')}
        <div class="conv-bubble">${convCollapsible(head, detail, !textMatchesTerm(flat.text, searchTerm), 'conv-reasoning')}${toolsHtml}</div>
      </div>`;
    }

    // User prompt: text is the hero, in the accent bubble.
    if (role === 'user') {
      const answer = flat.text ? `<div class="conv-answer conv-md">${renderMessageBody(flat.text, searchTerm)}</div>` : '';
      return `<div class="conv-turn conv-turn--user">
        ${convAvatar('user')}
        <div class="conv-bubble">${answer}${toolsHtml}</div>
      </div>`;
    }

    // assistant / tool / other
    const cls    = role === 'assistant' ? 'assistant' : (role === 'tool' ? 'tool' : 'other');
    const finish = flat.finish ? `<span class="conv-finish">${highlightTerm(flat.finish, searchTerm)}</span>` : '';
    const reasoning = flat.reasoning.length
      ? convCollapsible(
          `<span class="conv-chevron">▸</span><span class="conv-think">Thought for a moment</span>`,
          `<div class="genai-text conv-reason conv-md">${highlightHtmlText(mdToHtml(flat.reasoning.join('\n\n')), searchTerm)}</div>`,
          !textMatchesTerm(flat.reasoning, searchTerm), 'conv-reasoning')
      : '';
    const answer = flat.text
      ? `<div class="conv-answer conv-md">${renderMessageBody(flat.text, searchTerm)}</div>`
      : (flat.toolCalls.length && role === 'assistant'
          ? `<div class="conv-answer conv-answer--muted">(no text response — used tools)</div>`
          : '');
    return `<div class="conv-turn conv-turn--${cls}">
      ${convAvatar(role)}
      <div class="conv-bubble">
        <div class="conv-meta"><span class="conv-speaker">${highlightTerm(role, searchTerm)}</span>${finish}</div>
        ${reasoning}
        ${toolsHtml}
        ${answer}
      </div>
    </div>`;
  }

  /** Ingest a session's captured model turns: group them by trace id so selecting
   * a trace can render just that trace's conversation. Guards a stale response
   * arriving after the user has switched sessions. @param {string} sessionId @param {any} data */
  function onSessionMessages(sessionId, data) {
    if (sessionId !== selectedSessionId) { return; }
    sessionMessagesByTrace = new Map();
    const turns = (data && Array.isArray(data.turns)) ? data.turns : [];
    for (const t of turns) {
      const arr = sessionMessagesByTrace.get(t.traceId) || [];
      arr.push(t);
      sessionMessagesByTrace.set(t.traceId, arr);
    }
    sessionMessagesReady = true;
    // Refresh the pane if the user already picked a trace before messages arrived.
    if (selectedConvTraceId) { renderTraceConversation(selectedConvTraceId); }
  }

  /** Render one trace's conversation transcript into the session detail pane.
   * Deduped user prompts + assistant answers, with reasoning/tool calls tucked
   * into collapsibles. Shows loading/empty states as appropriate. @param {string} traceId */
  function renderTraceConversation(traceId) {
    const panel = $('session-span-detail');
    if (!panel) { return; }
    selectedConvTraceId = traceId;
    const trace = sessionTraceMap.get(traceId);
    const title = trace ? esc(trace.rootSpanName || '(unnamed trace)') : esc(traceId);
    const errChip = trace && trace.hasError ? `<span class="session-chip session-chip--err">error</span>` : '';
    const metaParts = trace
      ? [esc(trace.serviceName), fmtNano(trace.startTimeUnixNano), fmtMs(trace.durationMs)].filter(Boolean)
      : [];
    const meta = metaParts.length ? `<div class="conv-trace-meta">${metaParts.join(' · ')}</div>` : '';

    let body;
    if (!sessionMessagesReady) {
      body = `<div class="conv-loading">Loading conversation…</div>`;
    } else {
      const turns = sessionMessagesByTrace.get(traceId) || [];
      if (!turns.length) {
        body = `<div class="conv-empty">No captured model responses for this trace.<br>Enable <code>chat.agentHost.otel.captureContent</code> to record content, or expand the trace to inspect its spans.</div>`;
      } else {
        const rows = [];
        let prevPrompt = null;
        for (const t of turns) {
          if (t.inputPreview && t.inputPreview !== prevPrompt) {
            rows.push(convUserRow(t.inputPreview, t));
            prevPrompt = t.inputPreview;
          }
          rows.push(convAssistantRow(t, flattenTurn(t.outputMessages)));
        }
        body = `<div class="conv-body">${rows.join('')}</div>`;
      }
    }
    panel.innerHTML = `
      <div class="conv-trace-header">
        <div class="conv-trace-title">${title}${errChip}</div>
        ${meta}
      </div>
      <div class="conv-trace-kicker">Full conversation</div>
      ${body}`;
  }

  /** Render a session's traces (reuses the trace-row look; expands to span waterfalls). */
  function renderSessionTraces(/** @type {any[]} */ traces) {
    if (!sessionTracesList) { return; }
    if (!traces.length) {
      const term = activeTraceSearchTerm;
      sessionTracesList.innerHTML = `<div class="empty-state">${term ? 'No traces match the search.' : 'No traces in this session.'}</div>`;
      return;
    }
    sessionTraceMap = new Map(traces.map(t => [t.traceId, t]));
    sessionTracesList.innerHTML = traces.map((t) => {
      const isOpen = expandedTraces.has(t.traceId);
      const isMetadata = t.rootSpanName === 'vscode.agent_host.session.title_changed';
      const term   = activeTraceSearchTerm;
      return `
        <div class="trace-row ${t.hasError ? 'row--error' : ''} ${isOpen ? '' : 'collapsed'}" data-id="${esc(t.traceId)}">
          <span class="expand-icon" aria-hidden="true">${isOpen ? '▾' : '▸'}</span>
          <span class="cell cell--name">
            <span class="trace-name">${highlightTerm(t.rootSpanName, term)}</span>
            <span class="trace-id">${highlightTerm(t.traceId, term)}</span>
          </span>
          <span class="cell cell--service">${esc(t.serviceName || (isMetadata ? 'metadata' : ''))}</span>
          <span class="cell cell--ts">${fmtNano(t.startTimeUnixNano)}</span>
          <span class="cell cell--dur">${fmtMs(t.durationMs)}</span>
          <span class="cell cell--spans">${t.spanCount} span${t.spanCount !== 1 ? 's' : ''}</span>
        </div>
        ${matchRowsHtml(t.traceId)}
        <div class="waterfall-container" id="ssc-${esc(t.traceId)}" data-span-container="${esc(t.traceId)}"
             style="display:${isOpen ? 'block' : 'none'}">
          <div class="loading-row">loading spans…</div>
        </div>
      `;
    }).join('');

    bindMatchRowHandlers(sessionTracesList);

    sessionTracesList.querySelectorAll('.trace-row').forEach(row => {
      row.addEventListener('click', () => {
        const id        = /** @type {HTMLElement} */ (row).dataset.id ?? '';
        // Selecting a trace shows its conversation transcript in the detail pane.
        sessionTracesList.querySelectorAll('.trace-row--active').forEach(r => r.classList.remove('trace-row--active'));
        row.classList.add('trace-row--active');
        document.querySelectorAll('.waterfall-row.selected').forEach(r => r.classList.remove('selected'));
        renderTraceConversation(id);
        // Toggle the span waterfall as before.
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

    // Repopulate spans for traces left open across a re-render (e.g. tab return);
    // the markup above reset them to the "loading spans…" placeholder.
    for (const t of traces) {
      if (expandedTraces.has(t.traceId)) {
        vscode.postMessage({ type: 'getSpans', traceId: t.traceId });
      }
    }

    if (pendingSessionTraceId) {
      const traceId = pendingSessionTraceId;
      pendingSessionTraceId = null;
      focusSessionTrace(traceId);
    }
  }

  /** Expand and scroll to a trace within the selected session. */
  function focusSessionTrace(/** @type {string} */ traceId) {
    if (!traceId || !sessionTracesList) { return; }
    const row = [...sessionTracesList.querySelectorAll('.trace-row')]
      .find(el => /** @type {HTMLElement} */ (el).dataset.id === traceId);
    if (!row) {
      pendingSessionTraceId = traceId;
      return;
    }

    const container = $(`ssc-${traceId}`);
    if (container) {
      expandedTraces.add(traceId);
      container.style.display = 'block';
      row.classList.remove('collapsed');
      const icon = row.querySelector('.expand-icon');
      if (icon) { icon.textContent = '▾'; }
      if (container.querySelector('.loading-row')) {
        vscode.postMessage({ type: 'getSpans', traceId });
      }
    }

    row.scrollIntoView({ behavior: 'smooth', block: 'center' });
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
    // Say so explicitly when the list is a page rather than the whole result:
    // silently truncating makes an absent trace look like a search bug.
    const noun = activeTraceSearchTerm ? 'matching traces' : 'traces';
    const pageNote = tracesHasMore
      ? `<div class="trace-page-note">Showing the first ${traces.length} ${noun}.</div>`
      : '';
    const moreBtn = tracesHasMore
      ? `<div class="trace-page-more">
           <button class="trace-page-more-btn" type="button">Show ${TRACE_PAGE_SIZE} more</button>
         </div>`
      : '';
    tracesList.innerHTML = pageNote + traces.map((t) => {
      const isOpen     = expandedTraces.has(t.traceId);
      const isSelected = selectedTraceIds.has(t.traceId);
      const isMetadata = t.rootSpanName === 'vscode.agent_host.session.title_changed';
      const term       = activeTraceSearchTerm;
      const nameHtml   = highlightTerm(t.rootSpanName, term);
      const idHtml     = highlightTerm(t.traceId, term);
      return `
        <div class="trace-row ${t.hasError ? 'row--error' : ''} ${isOpen ? '' : 'collapsed'}" data-id="${esc(t.traceId)}">
          <span class="expand-icon" aria-hidden="true">${isOpen ? '▾' : '▸'}</span>
          <span class="cell cell--name">
            <span class="trace-name">${nameHtml}</span>
            <span class="trace-id">${idHtml}</span>
          </span>
          <span class="cell cell--service">${esc(t.serviceName || (isMetadata ? 'metadata' : ''))}</span>
          <span class="cell cell--ts">${fmtNano(t.startTimeUnixNano)}</span>
          <span class="cell cell--dur">${fmtMs(t.durationMs)}</span>
          <span class="cell cell--spans">${t.spanCount} span${t.spanCount !== 1 ? 's' : ''}</span>
          <button class="add-to-chat-btn${isSelected ? ' add-to-chat-btn--selected' : ''}" title="Add trace to chat" tabindex="-1">${isSelected ? '✓ added' : '+ chat'}</button>
        </div>
        ${matchRowsHtml(t.traceId)}
        <div class="waterfall-container" id="sc-${esc(t.traceId)}"
             style="display:${isOpen ? 'block' : 'none'}">
          <div class="loading-row">loading spans…</div>
        </div>
      `;
    }).join('') + moreBtn;

    // Swap the button for a spinner on click: the host runs the query
    // synchronously and can take seconds, so an unchanged button reads as a dead
    // control. The webview is a separate process from the host, so the animation
    // keeps running while the host is blocked. Replacing the button (rather than
    // just disabling it) also makes a second click impossible — each one would
    // cost another full query. Using .loading-row means renderRequestError turns
    // this into a failure message if the query errors, instead of spinning forever.
    const morePage = tracesList.querySelector('.trace-page-more');
    morePage?.querySelector('.trace-page-more-btn')?.addEventListener('click', () => {
      morePage.innerHTML =
        `<div class="loading-row"><span class="spinner" aria-hidden="true"></span>Loading ${TRACE_PAGE_SIZE} more…</div>`;
      showMoreTraces();
    });

    bindMatchRowHandlers(tracesList);

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

    // Traces left open across a re-render (e.g. returning to this tab) had their
    // waterfall reset to the "loading spans…" placeholder above. Re-request their
    // spans so they repopulate instead of sitting stuck on the placeholder.
    for (const t of traces) {
      if (expandedTraces.has(t.traceId)) {
        vscode.postMessage({ type: 'getSpans', traceId: t.traceId });
      }
    }

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

    const INDENT_STEP = 22;

    /** @param {any} node @param {number} depth @returns {string} */
    function nodeHtml(node, depth) {
      const isErr     = node.statusCode === 2;
      const indent    = depth * INDENT_STEP;
      const startNano = BigInt(node.startTimeUnixNano);
      const durNano   = BigInt(Math.round(node.durationMs * 1_000_000));
      const offsetPct = traceTotalNano > 0n
        ? Number((startNano - traceStartNano) * 10000n / traceTotalNano) / 100
        : 0;
      const widthPct = traceTotalNano > 0n
        ? Math.max(0.3, Number(durNano * 10000n / traceTotalNano) / 100)
        : 100;
      const barColor = isErr ? 'var(--err)' : spanKindColor(node.kind);
      const term = activeTraceSearchTerm;

      return `
        <div class="waterfall-row ${isErr ? 'row--error' : ''}"
             data-span-id="${esc(node.spanId)}"
             data-trace-id="${esc(traceId)}">
          <div class="waterfall-info" style="padding-left:${indent + 4}px">
            <span class="waterfall-name" title="${esc(node.name)}">${highlightTerm(node.name, term)}</span>
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

    // Highlight in the active surface when the trace exists in both tabs.
    const activeContainer = activeTab === 'sessions' ? $(`ssc-${traceId}`) : $(`sc-${traceId}`);
    const container = activeContainer || containers[0];
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

  // Long attribute values open in the viewer — the one way to read them in
  // full. Bound to the document rather than to each detail pane: the same
  // attributes table is rendered by the traces, sessions and logs panels, and a
  // per-pane handler silently misses any pane that is added later.
  document.addEventListener('click', e => {
    const btn = /** @type {HTMLElement} */ (e.target)?.closest('.attr-expand');
    if (!btn) { return; }
    // Read the text back out of the DOM rather than duplicating a 90 KB value
    // into a data attribute. textContent also strips any <mark> search
    // highlighting, which gives us the original value for free.
    const text = btn.closest('.attr-row-long')?.querySelector('.attr-val-text')?.textContent ?? '';
    openAttrModal(/** @type {HTMLElement} */ (btn).dataset['attrkey'] ?? 'Attribute', text);
  });

  // Toggle collapsible conversation-transcript sections (panel, reasoning, tools).
  document.addEventListener('click', e => {
    const toggle = /** @type {HTMLElement} */ (e.target)?.closest('.conv-toggle');
    if (!toggle) { return; }
    const box = toggle.closest('.conv-collapsible');
    if (!box) { return; }
    const collapsed = box.classList.toggle('conv-collapsed');
    const chevron = toggle.querySelector('.conv-chevron');
    if (chevron) { chevron.textContent = collapsed ? '▸' : '▾'; }
  });

  function openConversationSourceSpan(/** @type {HTMLElement} */ bubble) {
    const traceId = bubble.dataset['convTraceId'] ?? '';
    const spanId = bubble.dataset['convSpanId'] ?? '';
    if (traceId && spanId) { jumpToSpanInTrace(traceId, spanId); }
  }

  document.addEventListener('click', e => {
    const target = /** @type {HTMLElement} */ (e.target);
    const bubble = target?.closest('.conv-bubble[data-conv-trace-id][data-conv-span-id]');
    if (!bubble || target.closest('a, button, .conv-collapsible')) { return; }
    if (window.getSelection()?.toString()) { return; }
    openConversationSourceSpan(/** @type {HTMLElement} */ (bubble));
  });

  document.addEventListener('keydown', e => {
    if (e.key !== 'Enter' && e.key !== ' ') { return; }
    const bubble = /** @type {HTMLElement} */ (e.target)?.closest('.conv-bubble[data-conv-trace-id][data-conv-span-id]');
    if (!bubble || e.target !== bubble) { return; }
    e.preventDefault();
    openConversationSourceSpan(bubble);
  });

  // Cells that truncate hide their content with no way to read it. Rather than
  // annotating every render site — which silently misses any cell added later —
  // fill in the tooltip on hover, for whichever element is actually clipped.
  const TOOLTIP_MAX = 800;

  /** @param {HTMLElement} el @param {string} text */
  function setAutoTitle(el, text) {
    // Never clobber a title the renderer set deliberately.
    if (el.hasAttribute('title') && !el.hasAttribute('data-auto-title')) { return; }
    // A tooltip holding kilobytes of JSON is unreadable and gets clipped by the
    // OS anyway; show a preview and leave the full value to click-to-expand.
    if (text.length > TOOLTIP_MAX) { text = text.slice(0, TOOLTIP_MAX) + '…'; }

    if (text) {
      el.setAttribute('title', text);
      el.setAttribute('data-auto-title', '');
    } else if (el.hasAttribute('data-auto-title')) {
      // No longer truncated (panel widened, value expanded) — drop the tooltip.
      el.removeAttribute('title');
      el.removeAttribute('data-auto-title');
    }
  }

  /** @param {Element} el */
  function isClipped(el) {
    return el instanceof HTMLElement && el.scrollWidth > el.clientWidth;
  }

  document.addEventListener('mouseover', e => {
    const el = e.target;
    if (!(el instanceof HTMLElement)) { return; }

    // A trace row's name cell stacks the title over the id, and either can clip
    // on its own. Whichever one is hovered, report both: the title repeats across
    // runs, and the id alone is unreadable.
    const nameCell = el.closest('.trace-row .cell--name');
    if (nameCell instanceof HTMLElement) {
      const nameEl = nameCell.querySelector('.trace-name');
      const idEl   = nameCell.querySelector('.trace-id');
      const parts  = [];
      if ([nameEl, idEl].some(c => c && isClipped(c))) {
        const name = (nameEl?.textContent ?? '').trim();
        const id   = (idEl?.textContent ?? '').trim();
        if (name) { parts.push(name); }
        if (id)   { parts.push(`id: ${id}`); }
      }
      setAutoTitle(nameCell, parts.join('\n'));
      return;
    }

    const cs = getComputedStyle(el);
    // Single-line cells clipped horizontally, and multi-line values clamped to a
    // few lines (span details).
    const clipped = (isClipped(el) && cs.textOverflow === 'ellipsis')
      || (el.scrollHeight > el.clientHeight && cs.webkitLineClamp !== 'none');

    setAutoTitle(el, clipped ? (el.textContent ?? '').trim() : '');
  }, true);

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
    const term = activeTraceSearchTerm;

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
               // Long values stay clamped even when they match: a match can sit
               // inside a 90 KB value, and unclamping would flood the panel. The
               // row tint says the match is in there; the viewer shows where.
               const isMatch = textMatchesTerm(k, term) || textMatchesTerm(v, term);
               const keyCell = isLong
                 ? `<td class="attr-key">${highlightTerm(k, term)}${attrExpandBtn(k)}</td>`
                 : `<td class="attr-key">${highlightTerm(k, term)}</td>`;
               const valCell = isLong
                 ? `<td class="attr-val"><span class="attr-val-text collapsed">${highlightTerm(text, term)}</span></td>`
                 : `<td class="attr-val"><span class="attr-val-text">${highlightTerm(text, term)}</span></td>`;
               return `<tr class="${isLong ? 'attr-row-long' : ''}${isMatch ? ' attr-row--match' : ''}">${keyCell}${valCell}</tr>`;
             }).join('')}
           </table>
         </div>`
      : '<div class="attrs-empty">No attributes</div>';

    return `
      <div class="span-detail-content">
        <div class="right-panel-span-name">${highlightTerm(node.name, term)}</div>
        <div class="span-meta-grid">${metaHtml}</div>
        ${contentHtml}
        ${attrsHtml}
      </div>
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

  // ── Attribute value viewer ────────────────────────────────────────────────
  // A long attribute is unreadable in a 3-line clamp inside a narrow panel, and
  // the worst offenders are the most useful (gen_ai.tool.definitions runs to
  // ~90 KB of single-line JSON). This opens one in a roomy modal instead.

  /** @type {HTMLElement | null} */
  let attrModalEl = null;
  /** The value currently on screen, kept unescaped so both views derive from it. */
  let attrModalText = '';

  function closeAttrModal() {
    attrModalEl?.remove();
    attrModalEl = null;
    attrModalText = '';
  }

  /** Render the body for the chosen view and sync the segmented control.
   *  @param {'formatted' | 'original'} mode */
  function setAttrModalMode(mode) {
    if (!attrModalEl) { return; }
    const body = attrModalEl.querySelector('.attr-modal-body');
    if (body) {
      const shown = mode === 'formatted' ? prettyJson(attrModalText) : attrModalText;
      // Highlight the active search term so a hit buried in a long value (these
      // run to tens of KB) is findable without hunting. highlightTerm escapes
      // the text, so setting innerHTML here is safe; textContent-based Copy is
      // unaffected since <mark> wrappers drop out of textContent.
      body.innerHTML = highlightTerm(shown, activeTraceSearchTerm);
    }
    attrModalEl.querySelectorAll('.attr-modal-mode').forEach(btn => {
      const isOn = /** @type {HTMLElement} */ (btn).dataset['mode'] === mode;
      btn.setAttribute('aria-pressed', String(isOn));
    });
  }

  /** @param {string} key @param {string} text */
  function openAttrModal(key, text) {
    closeAttrModal();
    attrModalText = text;

    // Only offer the two views when they'd actually differ. Most long values
    // here are prose with real newlines, where "Formatted" is a no-op — and a
    // control that visibly does nothing reads as broken.
    const isJson = tryParseJson(text) !== undefined && /^[[{]/.test(text.trim());

    const backdrop = document.createElement('div');
    backdrop.className = 'attr-modal-backdrop';
    backdrop.innerHTML = `
      <div class="attr-modal" role="dialog" aria-modal="true" aria-label="Attribute value">
        <div class="attr-modal-head">
          <div class="attr-modal-key" title="${esc(key)}">${esc(key)}</div>
          ${isJson ? `<div class="attr-modal-modes">
            <button class="attr-modal-mode" data-mode="formatted" aria-pressed="true">Formatted</button>
            <button class="attr-modal-mode" data-mode="original" aria-pressed="false">Original</button>
          </div>` : ''}
          <button class="attr-modal-btn attr-modal-copy">Copy</button>
          <button class="attr-modal-close" title="Close (Esc)">✕</button>
        </div>
        <pre class="attr-modal-body"></pre>
        <div class="attr-modal-foot">${text.length.toLocaleString()} characters</div>
      </div>`;

    document.body.appendChild(backdrop);
    attrModalEl = backdrop;
    setAttrModalMode(isJson ? 'formatted' : 'original');

    // Jump to the first hit so the reason this attribute matched is on screen,
    // rather than leaving the user to scroll a huge value looking for it.
    /** @type {HTMLElement | null} */
    (backdrop.querySelector('.attr-modal-body .search-hit'))?.scrollIntoView({ block: 'center' });

    backdrop.addEventListener('click', e => {
      const target = /** @type {HTMLElement} */ (e.target);
      // A click that lands on the backdrop itself (not the dialog) is a dismiss.
      if (target === backdrop || target.closest('.attr-modal-close')) { closeAttrModal(); return; }

      const mode = target.closest('.attr-modal-mode');
      if (mode) {
        const m = /** @type {HTMLElement} */ (mode).dataset['mode'];
        setAttrModalMode(m === 'original' ? 'original' : 'formatted');
        return;
      }

      const copy = target.closest('.attr-modal-copy');
      if (copy) {
        // Copy what's on screen, not the source: someone who switched to
        // Formatted wants the formatted text.
        const shown = attrModalEl?.querySelector('.attr-modal-body')?.textContent ?? '';
        navigator.clipboard?.writeText(shown).then(() => {
          copy.textContent = 'Copied';
          setTimeout(() => { if (copy.isConnected) { copy.textContent = 'Copy'; } }, 1200);
        }, () => { copy.textContent = 'Copy failed'; });
      }
    });

    /** @type {HTMLElement | null} */ (backdrop.querySelector('.attr-modal-close'))?.focus();
  }

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && attrModalEl) { closeAttrModal(); }
  });

  /** The markup for the viewer button shown on a long attribute row.
   *  @param {string} key */
  function attrExpandBtn(key) {
    return `<button class="attr-expand" data-attrkey="${esc(key)}" title="Open in a window">⤢</button>`;
  }

  /** Build the readable conversation section from a span's gen_ai.* content
   * attributes: system instructions + input history + the model's output,
   * rendered as one readable transcript. Tool spans render their call arguments
   * and result as a tool row. Reasoning and tool payloads stay collapsed. @param {any} node */
  function genaiContentHtml(node) {
    const a = node.attributes ?? {};
    const term = activeTraceSearchTerm;
    // The conversation transcript below is built from gen_ai.* attributes that
    // are deliberately excluded from the raw Attributes table, so a search hit
    // inside a prompt/response would otherwise be invisible. Flag it here.
    const matchInConversation = !!term && Array.from(GENAI_CONTENT_KEYS)
      .some(k => textMatchesTerm(a[k], term));

    /** @type {any[]} */
    const messages = [];
    const input = tryParseJson(a['gen_ai.input.messages']);
    if (Array.isArray(input)) { messages.push(...input); }

    // Prepend system instructions only if the input history didn't already carry one.
    if (a['gen_ai.system_instructions'] != null && !messages.some(m => m && m.role === 'system')) {
      const parsed = tryParseJson(a['gen_ai.system_instructions']);
      const text = Array.isArray(parsed)
        ? parsed.map(p => (p && typeof p === 'object') ? (p.content ?? p.text ?? '') : String(p)).join('\n')
        : String(a['gen_ai.system_instructions']);
      messages.unshift({ role: 'system', parts: [{ type: 'text', content: text }] });
    }

    const output = tryParseJson(a['gen_ai.output.messages']);
    if (Array.isArray(output)) { messages.push(...output); }

    // Tool spans (gen_ai.tool.*): render the call + result as a tool row.
    const toolChips = [];
    const toolName = a['gen_ai.tool.name'] ? String(a['gen_ai.tool.name']) : 'tool';
    if (a['gen_ai.tool.call.arguments'] != null) { toolChips.push(convToolChip({ name: toolName, args: a['gen_ai.tool.call.arguments'] }, term)); }
    if (a['gen_ai.tool.call.result']    != null) { toolChips.push(convToolChip({ name: toolName, response: a['gen_ai.tool.call.result'] }, term)); }

    // Map tool_call id -> name so tool_call_response rows can be labeled with
    // the tool that produced them (responses only carry an id, not a name).
    /** @type {Record<string,string>} */
    const toolNames = {};
    for (const m of messages) {
      if (m && Array.isArray(m.parts)) {
        for (const p of m.parts) {
          if (p && p.type === 'tool_call' && p.id != null && p.name) { toolNames[p.id] = String(p.name); }
        }
      }
    }

    const rows = messages.map(m => convRow(m, toolNames, term)).join('');
    const toolRow = toolChips.length
      ? `<div class="conv-turn conv-turn--tool">
           ${convAvatar('tool')}
           <div class="conv-bubble"><div class="conv-meta"><span class="conv-speaker">${highlightTerm(toolName, term)}</span></div>${toolChips.join('')}</div>
         </div>`
      : '';

    return `<div class="genai-section">
      <div class="attrs-title">Conversation${matchInConversation ? ' <span class="search-match-badge" title="The search term matched text in this conversation">🔎 match</span>' : ''}</div>
      ${(rows || toolRow)
        ? `<div class="conv-body conv-body--span">${rows}${toolRow}</div>`
        : `<div class="attrs-empty">No conversation content captured for this span.</div>`}
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
      <span class="util-summary-item"><span class="util-summary-val">${fmtMs(s.avgDurationMs)}</span> avg</span>
      ${errItem}
    </div>`;

    const rowsHtml = s.byModel.map((/** @type {any} */ m) => {
      const expanded = expandedUtilModels.has(m.model);
      const head = `<tr class="util-model-row${m.errorCount ? ' row--error' : ''}${expanded ? ' util-model-row--open' : ''}" data-util-model="${esc(m.model)}">
        <td><span class="util-chevron">${expanded ? '▾' : '▸'}</span><span class="util-model-name" title="${esc(m.model)}">${esc(m.model)}</span></td>
        <td>${m.callCount}</td>
        <td>${fmtNum(m.totalTokens)}</td>
        <td>${fmtMs(m.avgDurationMs)} <span class="util-agg-label">(avg)</span></td>
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
          <td></td>
          <td>${fmtNum(c.totalTokens)}</td>
          <td class="util-call-dur">${fmtMs(c.durationMs)} <span class="util-call-open">↗</span></td>
        </tr>`).join('');
      const remaining = m.callCount - calls.length;
      const more = remaining > 0
        ? `<tr class="util-call-more" data-util-more="${esc(m.model)}" title="Show more calls">
             <td colspan="4">
               <div class="util-call-more-inner">
                 <span class="util-call-more-action">Show more</span>
                 <span class="util-call-more-count">${calls.length} / ${m.callCount}</span>
               </div>
             </td>
           </tr>`
        : '';
      return head + items + more;
    }).join('');

    el.innerHTML = summary + `<div class="table-scroll"><table class="data-table util-model-table">
      <thead><tr><th>Model</th><th>Calls</th><th>Tokens</th><th>Duration</th></tr></thead>
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
                 ? `<td class="attr-key">${esc(k)}${attrExpandBtn(k)}</td>`
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
  /** Instrument type → Codicon. `dist/codicon.css` is loaded by panel.ts. */
  const METRIC_ICON = { histogram: 'graph', sum: 'symbol-number', gauge: 'dashboard' };

  /** Windows offered by the Metrics range filter; `ms: 0` means all time. */
  const METRIC_RANGES = [
    { key: '',    label: 'All time',        ms: 0 },
    { key: '5m',  label: 'Last 5 minutes',  ms: 5 * 60_000 },
    { key: '30m', label: 'Last 30 minutes', ms: 30 * 60_000 },
    { key: '1h',  label: 'Last hour',       ms: 60 * 60_000 },
    { key: '24h', label: 'Last 24 hours',   ms: 24 * 60 * 60_000 },
    { key: '7d',  label: 'Last 7 days',     ms: 7 * 24 * 60 * 60_000 },
  ];

  /** Start of the active window as a nanosecond epoch string, or undefined for
   *  all time. BigInt because ms×1e6 overflows Number's safe integer range. */
  function metricSinceNano() {
    const r = METRIC_RANGES.find(x => x.key === selectedMetricRange);
    if (!r || !r.ms) { return undefined; }
    return (BigInt(Date.now() - r.ms) * 1000000n).toString();
  }

  function fetchMetricInstruments() {
    vscode.postMessage({ type: 'getMetricInstruments', sinceNano: metricSinceNano() });
  }

  /** Make metric list titles readable while preserving the full instrument name
   *  for selection, tooltips, and the detail panel. */
  function metricDisplayName(/** @type {string} */ name) {
    const withoutPrefix = name.replace(/^(?:claude_code|gen_ai\.client)\./, '');
    const readable = withoutPrefix.replace(/[._]+/g, ' ').trim();
    return readable ? readable.charAt(0).toUpperCase() + readable.slice(1) : name;
  }

  function renderMetricInstruments(/** @type {any[]} */ instruments) {
    currentInstruments = instruments || [];
    // The service list is derived from the instruments themselves, not the
    // span-derived service list, so it only offers services that have metrics.
    renderMetricServiceFilter();
    renderMetricList();
  }

  /** Render the (optionally filtered) instrument list in the left rail. */
  function renderMetricList() {
    if (!metricsList) { return; }
    if (!currentInstruments.length) {
      metricsList.innerHTML = selectedMetricRange
        ? '<div class="empty-state">No metrics in this time range.<br><small>Try a longer range.</small></div>'
        : '<div class="empty-state">No metrics yet.<br><small>Ingested OTLP metrics appear here.</small></div>';
      return;
    }
    let items = currentInstruments;
    if (selectedMetricService) {
      items = items.filter(i => i.serviceName === selectedMetricService);
    }

    if (!items.length) {
      metricsList.innerHTML = '<div class="empty-state small">No metrics for this service.</div>';
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
        const icon   = METRIC_ICON[i.metricType] || 'circle-small-filled';
        const unit   = i.unit ? `<span class="metric-unit">${esc(i.unit)}</span>` : '';
        html += `
          <div class="metric-row${active}" data-name="${esc(i.name)}" data-service="${esc(i.serviceName)}" title="${esc(i.name)}">
            <span class="metric-icon codicon codicon-${icon}" title="${esc(i.metricType)}" aria-hidden="true"></span>
            <span class="metric-name">${esc(metricDisplayName(i.name))}</span>
            ${unit}
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

  /** Service dropdown, built from whichever services currently have metrics. */
  function renderMetricServiceFilter() {
    if (!metricServiceFilterDropdown || !metricServiceFilterBtn) { return; }
    const names = [...new Set(currentInstruments.map(i => i.serviceName))].filter(Boolean).sort();
    // A previously-picked service can vanish when the time window narrows.
    if (selectedMetricService && !names.includes(selectedMetricService)) {
      selectedMetricService = '';
    }
    metricServiceFilterDropdown.innerHTML = ['', ...names].map(s => {
      const label = s || 'All services';
      return `<button class="service-filter-option${s === selectedMetricService ? ' active' : ''}" data-value="${esc(s)}">${esc(label)}</button>`;
    }).join('');
    metricServiceFilterDropdown.querySelectorAll('.service-filter-option').forEach(btn => {
      btn.addEventListener('click', e => {
        e.stopPropagation();
        selectedMetricService = /** @type {HTMLElement} */ (btn).dataset.value ?? '';
        setDropdownOpen(metricServiceFilterDropdown, metricServiceFilterBtn, false);
        syncMetricFilterLabels();
        renderMetricList();
      });
    });
    syncMetricFilterLabels();
  }

  /** Time-range dropdown. Changing the window re-queries the host, since the
   *  window is applied in SQL (and changes what cumulative totals mean). */
  function renderMetricRangeFilter() {
    if (!metricRangeFilterDropdown || !metricRangeFilterBtn) { return; }
    metricRangeFilterDropdown.innerHTML = METRIC_RANGES.map(r =>
      `<button class="service-filter-option${r.key === selectedMetricRange ? ' active' : ''}" data-value="${esc(r.key)}">${esc(r.label)}</button>`
    ).join('');
    metricRangeFilterDropdown.querySelectorAll('.service-filter-option').forEach(btn => {
      btn.addEventListener('click', e => {
        e.stopPropagation();
        selectedMetricRange = /** @type {HTMLElement} */ (btn).dataset.value ?? '';
        setDropdownOpen(metricRangeFilterDropdown, metricRangeFilterBtn, false);
        syncMetricFilterLabels();
        fetchMetricInstruments();
        // Keep the open detail pane consistent with the new window.
        if (selectedMetricKey) {
          const [name, service] = selectedMetricKey.split('|');
          selectMetric(name, service);
        }
      });
    });
    syncMetricFilterLabels();
  }

  /** Reflect the active service/range on the two toolbar buttons. */
  function syncMetricFilterLabels() {
    if (metricServiceFilterBtn) {
      const val = metricServiceFilterBtn.querySelector('.select-filter-value');
      if (val) { val.textContent = selectedMetricService || 'All services'; }
      metricServiceFilterBtn.classList.toggle('select-filter-btn--active', !!selectedMetricService);
    }
    if (metricRangeFilterBtn) {
      const r   = METRIC_RANGES.find(x => x.key === selectedMetricRange);
      const val = metricRangeFilterBtn.querySelector('.select-filter-value');
      if (val) { val.textContent = r ? r.label : 'All time'; }
      metricRangeFilterBtn.classList.toggle('select-filter-btn--active', !!selectedMetricRange);
    }
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
    vscode.postMessage({ type: 'getMetricDetail', name, serviceName: service, sinceNano: metricSinceNano() });
  }

  function renderMetricDetail(/** @type {any} */ d) {
    if (!metricDetailPanel) { return; }
    // Ignore late responses for a metric the user has navigated away from.
    if (selectedMetricKey && `${d.name}|${d.serviceName}` !== selectedMetricKey) { return; }

    const isHist = d.metricType === 'histogram';
    const u      = d.unit ? `<span class="metric-unit">${esc(d.unit)}</span>` : '';

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
          <span class="metric-icon codicon codicon-${METRIC_ICON[d.metricType] || 'circle-small-filled'}" aria-hidden="true"></span>
          <span class="metric-detail-name">${esc(d.name)}</span>
          ${u}
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

    wireChartHover(d.series);
  }

  /** Format a metric value compactly (whole numbers vs fractional). */
  function fmtMetricVal(/** @type {number} */ n) {
    if (n === 0) { return '0'; }
    if (Math.abs(n) >= 1000) { return fmtNum(n); }
    if (Number.isInteger(n)) { return String(n); }
    return n.toFixed(Math.abs(n) < 1 ? 3 : 2);
  }

  /** Chart box in viewBox units. The rendered height matches `H` 1:1, so SVG y
   *  coordinates double as CSS pixel offsets; x is stretched to the container
   *  width by preserveAspectRatio="none" and must be scaled explicitly. */
  const CHART = { W: 640, H: 160, padL: 8, padR: 8, padT: 18, padB: 22 };

  /** Shared scale for a series, so the plot and the hover readout can never
   *  disagree about where a point sits. */
  function chartScale(/** @type {{t:number,value:number}[]} */ series) {
    const { W, H, padL, padR, padT, padB } = CHART;
    const xs = series.map(p => p.t);
    const ys = series.map(p => p.value);
    const minX = Math.min(...xs), maxX = Math.max(...xs);
    const minY = Math.min(...ys), maxY = Math.max(...ys);
    const spanX = (maxX - minX) || 1;
    const spanY = (maxY - minY) || 1;
    return {
      minX, maxX, minY, maxY, spanX, spanY,
      px: (/** @type {number} */ x) => padL + ((x - minX) / spanX) * (W - padL - padR),
      py: (/** @type {number} */ y) => (H - padB) - ((y - minY) / spanY) * (H - padT - padB),
    };
  }

  /** @param {number} ms @param {boolean} withSeconds */
  function fmtChartTime(ms, withSeconds = false) {
    const dt = new Date(ms);
    const pad = (/** @type {number} */ n) => String(n).padStart(2, '0');
    const hms = `${pad(dt.getHours())}:${pad(dt.getMinutes())}${withSeconds ? `:${pad(dt.getSeconds())}` : ''}`;
    return `${pad(dt.getMonth() + 1)}/${pad(dt.getDate())} ${hms}`;
  }

  /** Hand-rolled inline SVG line chart (no external chart lib under CSP). */
  function buildSparkline(/** @type {{t:number,value:number}[]} */ series) {
    if (!series || series.length < 2) {
      return '<div class="empty-state small">Not enough data points to chart.</div>';
    }
    const { W, H, padL, padR, padB } = CHART;
    const s = chartScale(series);

    const pts  = series.map(p => `${s.px(p.t).toFixed(1)},${s.py(p.value).toFixed(1)}`);
    const line = pts.join(' ');
    const area = `${padL},${H - padB} ${line} ${(W - padR)},${H - padB}`;

    const yMaxPx = s.py(s.maxY), yMinPx = s.py(s.minY);
    const grid = (/** @type {number} */ y) =>
      `<line class="metric-chart-grid" x1="${padL}" y1="${y}" x2="${W - padR}" y2="${y}" />`;

    // The marker and tooltip are HTML rather than SVG: the non-uniform
    // viewBox stretch would deform an SVG circle into an ellipse.
    return `
      <div class="metric-chart-frame">
        <svg class="metric-chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img"
             aria-label="Values from ${esc(fmtMetricVal(s.minY))} to ${esc(fmtMetricVal(s.maxY))} between ${esc(fmtChartTime(s.minX))} and ${esc(fmtChartTime(s.maxX))}">
          ${grid(yMaxPx)}${grid(yMinPx)}
          <polyline class="metric-chart-area" points="${area}" />
          <polyline class="metric-chart-line" points="${line}" />
        </svg>
        <span class="metric-chart-y" style="top:${yMaxPx}px">${esc(fmtMetricVal(s.maxY))}</span>
        <span class="metric-chart-y" style="top:${yMinPx}px">${esc(fmtMetricVal(s.minY))}</span>
        <span class="metric-chart-dot" aria-hidden="true"></span>
        <div class="metric-chart-tip" role="status"></div>
      </div>
      <div class="metric-chart-axis">
        <span>${esc(fmtChartTime(s.minX))}</span>
        <span>${esc(fmtChartTime(s.maxX))}</span>
      </div>`;
  }

  /** Track the pointer across the plot and read out the nearest data point. */
  function wireChartHover(/** @type {{t:number,value:number}[]} */ series) {
    const frame = metricDetailPanel?.querySelector('.metric-chart-frame');
    if (!frame || !series || series.length < 2) { return; }
    const dot = frame.querySelector('.metric-chart-dot');
    const tip = frame.querySelector('.metric-chart-tip');
    if (!(dot instanceof HTMLElement) || !(tip instanceof HTMLElement)) { return; }

    const { W, padL, padR } = CHART;
    const s = chartScale(series);

    frame.addEventListener('mousemove', ev => {
      const rect = frame.getBoundingClientRect();
      if (!rect.width) { return; }
      // Undo the horizontal viewBox stretch before searching in data space.
      const vbX  = ((/** @type {MouseEvent} */ (ev).clientX - rect.left) / rect.width) * W;
      const frac = Math.min(1, Math.max(0, (vbX - padL) / (W - padL - padR)));
      const t    = s.minX + frac * s.spanX;

      let best = 0;
      for (let i = 1; i < series.length; i++) {
        if (Math.abs(series[i].t - t) < Math.abs(series[best].t - t)) { best = i; }
      }
      const p = series[best];
      const cssX = (s.px(p.t) / W) * rect.width;
      const cssY = s.py(p.value);

      dot.style.left   = `${cssX}px`;
      dot.style.top    = `${cssY}px`;

      // Keep the tooltip inside the plot: flip to the left of the marker once
      // there is no longer room to its right.
      const flip = cssX > rect.width - 120;
      tip.style.left      = `${cssX + (flip ? -10 : 10)}px`;
      tip.style.top       = `${Math.min(Math.max(cssY, 18), CHART.H - 18)}px`;
      tip.style.transform = `translate(${flip ? '-100%' : '0'}, -50%)`;
      tip.innerHTML =
        `<span class="metric-chart-tip-val">${esc(fmtMetricVal(p.value))}</span>` +
        `<span class="metric-chart-tip-t">${esc(fmtChartTime(p.t, true))}</span>`;

      frame.classList.add('is-hover');
    });

    frame.addEventListener('mouseleave', () => frame.classList.remove('is-hover'));
  }

  // ── Helpers ───────────────────────────────────────────────────────────────────
  /** @param {string} s */
  function esc(s) {
    return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  /** @param {string} s @returns {string} */
  function escRegExp(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  /** HTML-escapes `text` and wraps case-insensitive occurrences of `term` in
   *  `<mark>` so the user can see exactly where a search term matched, rather
   *  than just seeing a filtered result with no explanation.
   *  @param {unknown} text @param {string} term @returns {string} */
  function highlightTerm(text, term) {
    const escaped = esc(String(text ?? ''));
    if (!term) { return escaped; }
    try {
      // Match against the already-escaped text, so escape the term the same way
      // (e.g. searching for `<` needs to find the literal `&lt;` in `escaped`).
      const re = new RegExp(`(${escRegExp(esc(term))})`, 'ig');
      return escaped.replace(re, '<mark class="search-hit">$1</mark>');
    } catch { return escaped; }
  }

  /** Highlight visible text in an already-safe HTML fragment without touching
   * element names or attributes. @param {string} html @param {string} term */
  function highlightHtmlText(html, term) {
    if (!term) { return html; }
    const escapedTerm = esc(term);
    try {
      const re = new RegExp(`(${escRegExp(escapedTerm)})`, 'ig');
      return html.split(/(<[^>]+>)/g)
        .map(part => part.startsWith('<') ? part : part.replace(re, '<mark class="search-hit">$1</mark>'))
        .join('');
    } catch { return html; }
  }

  /** @param {unknown} value @param {string} term @returns {boolean} */
  function textMatchesTerm(value, term) {
    if (!term) { return false; }
    const text = typeof value === 'object' ? JSON.stringify(value) : String(value ?? '');
    return text.toLowerCase().includes(term.toLowerCase());
  }

  /** Minimal, XSS-safe Markdown → HTML for chat message text so assistant/user
   * turns read like a real conversation instead of raw `##`/`**`/backtick source.
   * Everything is HTML-escaped first; only a safe subset is then re-introduced
   * (fenced + inline code, headings, bold/italic, http(s) links, blockquotes,
   * horizontal rules, and ordered/unordered lists). The result is a block of
   * HTML meant to live inside a `.conv-md` container. @param {string} src */
  function mdToHtml(src) {
    const raw = String(src ?? '');
    if (!raw.trim()) { return ''; }
    // 1) Lift fenced code blocks out first so their contents are never marked up.
    /** @type {string[]} */
    const codeBlocks = [];
    let s = raw.replace(/```[\w-]*\r?\n?([\s\S]*?)```/g, (_m, code) => {
      codeBlocks.push(`<pre class="md-code"><code>${esc(String(code).replace(/\r?\n$/, ''))}</code></pre>`);
      return `\u0000CB${codeBlocks.length - 1}\u0000`;
    });
    // 2) Escape everything else, then lift inline code spans out.
    s = esc(s);
    /** @type {string[]} */
    const inlineCode = [];
    s = s.replace(/`([^`\n]+)`/g, (_m, code) => {
      inlineCode.push(`<code class="md-inline">${code}</code>`);
      return `\u0000IC${inlineCode.length - 1}\u0000`;
    });
    /** @param {string} t */
    const inline = (t) => t
      .replace(/\*\*([^*]+?)\*\*/g, '<strong>$1</strong>')
      .replace(/__([^_]+?)__/g, '<strong>$1</strong>')
      .replace(/(^|[^*])\*(?!\s)([^*\n]+?)\*/g, '$1<em>$2</em>')
      .replace(/(^|[^\w])_(?!\s)([^_\n]+?)_/g, '$1<em>$2</em>')
      .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" class="md-link">$1</a>');
    const lines = s.split('\n');
    /** @type {string[]} */
    const out = [];
    /** @type {string[]} */
    let para = [];
    const flush = () => { if (para.length) { out.push(`<p>${para.map(inline).join('<br>')}</p>`); para = []; } };
    for (let i = 0; i < lines.length; i++) {
      const t = lines[i].trim();
      if (!t) { flush(); continue; }
      if (/^\u0000CB\d+\u0000$/.test(t)) { flush(); out.push(t); continue; }
      const h = /^(#{1,6})\s+(.*)$/.exec(t);
      if (h) { flush(); const lvl = h[1].length; out.push(`<h${lvl} class="md-h">${inline(h[2])}</h${lvl}>`); continue; }
      if (/^(---|\*\*\*|___)$/.test(t)) { flush(); out.push('<hr class="md-hr">'); continue; }
      if (/^&gt;\s?/.test(t)) {
        flush();
        /** @type {string[]} */ const q = [];
        while (i < lines.length && /^&gt;\s?/.test(lines[i].trim())) { q.push(inline(lines[i].trim().replace(/^&gt;\s?/, ''))); i++; }
        i--;
        out.push(`<blockquote class="md-quote">${q.join('<br>')}</blockquote>`);
        continue;
      }
      if (/^[-*+]\s+/.test(t)) {
        flush();
        /** @type {string[]} */ const items = [];
        while (i < lines.length && /^[-*+]\s+/.test(lines[i].trim())) { items.push(`<li>${inline(lines[i].trim().replace(/^[-*+]\s+/, ''))}</li>`); i++; }
        i--;
        out.push(`<ul class="md-list">${items.join('')}</ul>`);
        continue;
      }
      if (/^\d+\.\s+/.test(t)) {
        flush();
        /** @type {string[]} */ const items = [];
        while (i < lines.length && /^\d+\.\s+/.test(lines[i].trim())) { items.push(`<li>${inline(lines[i].trim().replace(/^\d+\.\s+/, ''))}</li>`); i++; }
        i--;
        out.push(`<ol class="md-list">${items.join('')}</ol>`);
        continue;
      }
      para.push(t);
    }
    flush();
    return out.join('')
      .replace(/\u0000CB(\d+)\u0000/g, (_m, n) => codeBlocks[Number(n)] || '')
      .replace(/\u0000IC(\d+)\u0000/g, (_m, n) => inlineCode[Number(n)] || '');
  }

  /** Turn a `snake_case` tag name into a readable label. @param {string} name */
  function humanizeTag(name) {
    return name.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
  }

  /** Render a captured message body. Agent prompts wrap content in
   * `<snake_case>` tags (e.g. `<code_change_instructions>`,
   * `<system_reminder>`). Balanced pairs become collapsed, labeled sections, or
   * a compact label/value row when the whole body is one short line
   * (`<current_datetime>…</current_datetime>`). Tags are matched with a stack so
   * a close is recognized anywhere — including when it trails content on the
   * same line — and unbalanced tags degrade to literal text, which keeps prose
   * like `#include <string>` intact. Everything outside a tag is rendered with
   * mdToHtml; fenced code is lifted out first so tags inside code blocks are
   * left untouched. @param {string} src @param {string} [term] */
  function renderMessageBody(src, term) {
    const raw = String(src ?? '');
    if (!raw.trim()) { return ''; }
    /** @type {string[]} */
    const fences = [];
    const lifted = raw.replace(/```[\w-]*\r?\n?[\s\S]*?```/g, (m) => {
      fences.push(m);
      return `\u0000FENCE${fences.length - 1}\u0000`;
    });
    /** @param {string} s */
    const restore = (s) => s.replace(/\u0000FENCE(\d+)\u0000/g, (_m, n) => fences[Number(n)] || '');

    /** @type {any} */
    const root = { name: '', raw: '', children: [] };
    /** @type {any[]} */
    const stack = [root];
    /** @param {string} s */
    const addText = (s) => { if (s) { stack[stack.length - 1].children.push(s); } };
    const closeTop = () => {
      const done = stack.pop();
      stack[stack.length - 1].children.push(done);
    };
    // A tag that opened mid-line isn't markup: put its literal text back and
    // hoist its content into the parent so the surrounding prose is preserved.
    // One that opened on its own line is a real block whose close was lost
    // (captured text is often truncated), so close it implicitly instead.
    const unwind = () => {
      if (stack[stack.length - 1].block) { closeTop(); return; }
      const bad = stack.pop();
      stack[stack.length - 1].children.push(bad.raw, ...bad.children);
    };
    const re = /<(\/?)([a-z][a-z0-9_]*)>/g;
    let last = 0;
    let m;
    while ((m = re.exec(lifted))) {
      addText(lifted.slice(last, m.index));
      last = re.lastIndex;
      if (!m[1]) {
        const block = m.index === 0 || /\n[ \t]*$/.test(lifted.slice(0, m.index));
        stack.push({ name: m[2], raw: m[0], children: [], block });
        continue;
      }
      let depth = -1;
      for (let i = stack.length - 1; i > 0; i--) { if (stack[i].name === m[2]) { depth = i; break; } }
      if (depth < 0) { addText(m[0]); continue; }      // no matching open → literal
      while (stack.length - 1 > depth) { unwind(); }   // close any unclosed children
      closeTop();
    }
    // Truncated capture can end mid-tag ("…</sql_tab"); that fragment can never
    // be valid markup, so drop it rather than showing it raw.
    addText(lifted.slice(last).replace(/<\/?[a-z][a-z0-9_]*$/, ''));
    while (stack.length > 1) { unwind(); }

    /** @param {any[]} children */
    const renderKids = (children) => {
      /** @type {string[]} */ const parts = [];
      let buf = '';
      const flush = () => { if (buf.trim()) { parts.push(mdToHtml(restore(buf))); } buf = ''; };
      for (const c of children) {
        if (typeof c === 'string') { buf += c; continue; }
        flush();
        parts.push(renderTag(c));
      }
      flush();
      return parts.join('');
    };
    /** @param {any} node */
    const nodeText = (node) => node.children.map((c) => typeof c === 'string' ? c : nodeText(c)).join('');
    const renderTag = (node) => {
      const label = esc(humanizeTag(node.name));
      const body = node.children.every((c) => typeof c === 'string')
        ? node.children.join('')
        : null;
      // Metadata-style tags whose value sat inline on one source line read
      // better as a label/value row. Tested before trimming, since a newline
      // after the opening tag means the body is a block, not a scalar.
      if (body !== null && !body.includes('\n') && !body.includes('\u0000FENCE') && body.trim().length <= 120) {
        const val = body.trim();
        return `<div class="conv-kv"><span class="conv-kv-key">${label}</span>${
          val ? `<span class="conv-kv-val">${esc(val)}</span>` : ''}</div>`;
      }
      const head = `<span class="conv-chevron">▸</span><span class="conv-tag-name">${label}</span>`;
      return convCollapsible(
        head,
        `<div class="conv-tag-body">${renderKids(node.children)}</div>`,
        !textMatchesTerm(`${node.name}\n${nodeText(node)}`, term || ''),
        'conv-tag');
    };
    return highlightHtmlText(renderKids(root.children), term || '');
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
  renderMetricRangeFilter();
  vscode.postMessage({ type: 'ready' });
  // Load the default view (Home). A sidebar click will switchTab to another view
  // once the webview reports 'ready' (the extension queues it if needed).
  loadCurrentTab();
}());
