import * as vscode from 'vscode';
import * as path from 'path';
import { TelemetryStore, OtlpReceiver } from '@agent-insights/receiver';
import { AgentInsightsPanel } from './panel';
import { AgentNavProvider, navEntryFor } from './nav';
import { registerTools } from './tools';
import type { TabId } from '@agent-insights/types';

let receiver: OtlpReceiver | undefined;
let store: TelemetryStore | undefined;
let statusBarItem: vscode.StatusBarItem;

const DEFAULT_PORT = 4318;
/** VS Code's own agent-host exporter target. Producers point *at* our receiver,
 *  so this has to track the port the receiver actually bound. */
const ENDPOINT_SETTING = 'chat.agentHost.otel.otlpEndpoint';

/** The port the receiver is currently listening on, which is not necessarily the
 *  configured one — the configured port may have failed to bind. */
let currentPort = DEFAULT_PORT;

function configuredPort(): number {
  return vscode.workspace.getConfiguration('agentInsights').get<number>('port', DEFAULT_PORT);
}

function isPortInUse(err: unknown): boolean {
  return (err as NodeJS.ErrnoException | undefined)?.code === 'EADDRINUSE'
    || String(err).includes('EADDRINUSE');
}

/** Only endpoints aimed at this machine are ours to rewrite; a URL pointing at a
 *  real collector elsewhere is a deliberate choice and must be left alone.
 *  URL.hostname keeps the brackets on IPv6 literals, hence the '[::1]' form. */
function isLoopback(hostname: string): boolean {
  return hostname === 'localhost'
    || hostname === '127.0.0.1'
    || hostname === '::1'
    || hostname === '[::1]';
}

/** Where a setting is already defined, so an update lands in the same scope
 *  instead of silently shadowing a workspace value with a global one. */
function scopeOf(info: ReturnType<vscode.WorkspaceConfiguration['inspect']>): vscode.ConfigurationTarget {
  if (info?.workspaceFolderValue !== undefined) { return vscode.ConfigurationTarget.WorkspaceFolder; }
  if (info?.workspaceValue !== undefined)       { return vscode.ConfigurationTarget.Workspace; }
  return vscode.ConfigurationTarget.Global;
}

/** Issue #8516: the receiver and VS Code's exporter must agree on a port, or
 *  telemetry is silently dropped. Offer to fix rather than writing behind the
 *  user's back — this is their settings file. */
async function syncOtlpEndpoint(port: number): Promise<void> {
  const cfg     = vscode.workspace.getConfiguration();
  const info    = cfg.inspect<string>(ENDPOINT_SETTING);
  const current = cfg.get<string>(ENDPOINT_SETTING);
  // Unset means the user hasn't opted into agent-host telemetry; creating the
  // setting for them would be presumptuous.
  if (!info || !current) { return; }

  let url: URL;
  try { url = new URL(current); } catch { return; }
  if (!isLoopback(url.hostname) || url.port === String(port)) { return; }

  url.port = String(port);
  const target = url.toString().replace(/\/$/, '');
  const pick = await vscode.window.showWarningMessage(
    `Agent Insights is receiving on port ${port}, but "${ENDPOINT_SETTING}" points at ${current}. `
      + 'VS Code\'s agent telemetry will not reach the extension until they match.',
    `Update to ${target}`,
    'Not now',
  );
  if (pick?.startsWith('Update')) {
    await cfg.update(ENDPOINT_SETTING, target, scopeOf(info));
    vscode.window.showInformationMessage(`Agent Insights: ${ENDPOINT_SETTING} set to ${target}. Reload VS Code for it to take effect.`);
  }
}

/** Issue #8513: a bare EADDRINUSE is a dead end, so name the likely cause and
 *  offer the setting that fixes it. */
async function reportStartFailure(port: number, err: unknown): Promise<void> {
  const message = isPortInUse(err)
    ? `Agent Insights: port ${port} is already in use — usually another VS Code window running this extension, or another OTLP collector. `
        + `Set "agentInsights.port" to a free port (and match it in "${ENDPOINT_SETTING}").`
    : `Agent Insights: could not start the OTLP receiver on port ${port}. ${err}`;

  const pick = await vscode.window.showWarningMessage(message, 'Open Settings', 'Retry');
  if (pick === 'Open Settings') {
    await vscode.commands.executeCommand('workbench.action.openSettings', 'agentInsights.port');
  } else if (pick === 'Retry') {
    await restartReceiver(configuredPort());
  }
}

async function startReceiver(port: number): Promise<void> {
  receiver = new OtlpReceiver(store!, port);
  try {
    await receiver.start();
    currentPort = port;
    // This window owns the port, so it is the one allowed to persist.
    store!.enablePersistence();
    statusBarItem.text    = `$(broadcast) Agent :${port}`;
    statusBarItem.tooltip = `Agent Insights — OTLP/HTTP receiver on 127.0.0.1:${port}\nClick to open panel`;
    AgentInsightsPanel.currentPanel?.updatePort(port);
    void syncOtlpEndpoint(port);
  } catch (err) {
    // A server that failed to bind can't be reused, and its rejected 'error'
    // listener would leak across retries.
    receiver = undefined;
    statusBarItem.text    = `$(error) Agent`;
    statusBarItem.tooltip = `Agent Insights — receiver failed to start on port ${port}: ${err}\n`
      + 'Read-only: this window will not write to the telemetry database.';
    void reportStartFailure(port, err);
  }
}

async function restartReceiver(port: number): Promise<void> {
  await receiver?.stop().catch(() => undefined);
  receiver = undefined;
  await startReceiver(port);
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const dbPath = path.join(context.globalStorageUri.fsPath, 'telemetry.db');
  store = new TelemetryStore(dbPath);
  await store.initialize();

  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBarItem.command = 'agent-insights.openPanel';
  context.subscriptions.push(statusBarItem);

  await startReceiver(configuredPort());
  statusBarItem.show();

  const navProvider = new AgentNavProvider();
  const navView = vscode.window.createTreeView('agentInsightsNav', {
    treeDataProvider: navProvider,
  });
  // Keep the sidebar selection in sync with in-webview navigation (e.g. clicking
  // a trace link jumps to the Traces view, so highlight Traces in the sidebar).
  AgentInsightsPanel.onTabChange = (tab: TabId) => {
    const entry = navEntryFor(tab);
    if (entry && navView.visible) {
      navView.reveal(entry, { select: true, focus: false }).then(undefined, () => { /* ignore */ });
    }
  };

  context.subscriptions.push(
    navView,
    // A port change previously did nothing until the window was reloaded, with
    // no indication of that. Rebind in place instead.
    vscode.workspace.onDidChangeConfiguration(e => {
      if (!e.affectsConfiguration('agentInsights.port')) { return; }
      const next = configuredPort();
      if (next !== currentPort || !receiver) { void restartReceiver(next); }
    }),
    vscode.commands.registerCommand('agent-insights.showTab', (tab: TabId) => {
      AgentInsightsPanel.createOrShow(context.extensionUri, store!, currentPort);
      AgentInsightsPanel.currentPanel?.showTab(tab);
    }),
    vscode.commands.registerCommand('agent-insights.openPanel', () => {
      AgentInsightsPanel.createOrShow(context.extensionUri, store!, currentPort);
    }),
    vscode.commands.registerCommand('agent-insights.clearData', () => {
      // In a read-only window this would empty the view while the file (and the
      // owning window) kept the data — cleared until the next reload.
      if (!store!.isWritable) {
        vscode.window.showWarningMessage(
          'Agent Insights: this window is read-only because another window owns the OTLP port, so the data cannot be cleared from here. Use the window that is receiving telemetry.',
        );
        return;
      }
      store!.clear();
      vscode.window.showInformationMessage('Agent Insights: All telemetry data cleared.');
      AgentInsightsPanel.currentPanel?.refresh();
    }),
    vscode.commands.registerCommand('agent-insights.navigateToTrace', (traceId: string, spanId?: string) => {
      AgentInsightsPanel.createOrShow(context.extensionUri, store!, currentPort);
      AgentInsightsPanel.currentPanel?.navigateToTrace(traceId, spanId);
    }),
    vscode.window.registerUriHandler({
      handleUri(uri: vscode.Uri) {
        if (uri.path === '/navigate') {
          const params = new URLSearchParams(uri.query);
          const traceId = params.get('traceId');
          const spanId  = params.get('spanId') ?? undefined;
          if (traceId) {
            AgentInsightsPanel.createOrShow(context.extensionUri, store!, currentPort);
            AgentInsightsPanel.currentPanel?.navigateToTrace(traceId, spanId);
          }
        }
      },
    }),
  );

  registerTools(context, store);
}

export async function deactivate(): Promise<void> {
  await receiver?.stop().catch(() => undefined);
  store?.close();
}
