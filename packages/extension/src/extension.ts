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

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const dbPath = path.join(context.globalStorageUri.fsPath, 'telemetry.db');
  store = new TelemetryStore(dbPath);
  await store.initialize();

  const port = vscode.workspace
    .getConfiguration('agentInsights')
    .get<number>('port', 4318);

  receiver = new OtlpReceiver(store, port);

  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBarItem.command = 'agent-insights.openPanel';
  context.subscriptions.push(statusBarItem);

  try {
    await receiver.start();
    statusBarItem.text    = `$(broadcast) Agent :${port}`;
    statusBarItem.tooltip = `Agent Insights — OTLP/HTTP receiver on 127.0.0.1:${port}\nClick to open panel`;
  } catch (err) {
    statusBarItem.text    = `$(error) Agent`;
    statusBarItem.tooltip = `Agent Insights — receiver failed to start: ${err}`;
    vscode.window.showWarningMessage(
      `Agent Insights: Could not start OTLP receiver on port ${port}. ${err}`,
    );
  }
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
    vscode.commands.registerCommand('agent-insights.showTab', (tab: TabId) => {
      AgentInsightsPanel.createOrShow(context.extensionUri, store!, port);
      AgentInsightsPanel.currentPanel?.showTab(tab);
    }),
    vscode.commands.registerCommand('agent-insights.openPanel', () => {
      AgentInsightsPanel.createOrShow(context.extensionUri, store!, port);
    }),
    vscode.commands.registerCommand('agent-insights.clearData', () => {
      store!.clear();
      vscode.window.showInformationMessage('Agent Insights: All telemetry data cleared.');
      AgentInsightsPanel.currentPanel?.refresh();
    }),
    vscode.commands.registerCommand('agent-insights.navigateToTrace', (traceId: string, spanId?: string) => {
      AgentInsightsPanel.createOrShow(context.extensionUri, store!, port);
      AgentInsightsPanel.currentPanel?.navigateToTrace(traceId, spanId);
    }),
    vscode.window.registerUriHandler({
      handleUri(uri: vscode.Uri) {
        if (uri.path === '/navigate') {
          const params = new URLSearchParams(uri.query);
          const traceId = params.get('traceId');
          const spanId  = params.get('spanId') ?? undefined;
          if (traceId) {
            AgentInsightsPanel.createOrShow(context.extensionUri, store!, port);
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
