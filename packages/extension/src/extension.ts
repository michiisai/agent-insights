import * as vscode from 'vscode';
import * as path from 'path';
import { TelemetryStore, OtlpReceiver } from '@otel-insights/receiver';
import { OtelInsightsPanel } from './panel';
import { OtelNavProvider, navEntryFor } from './nav';
import { registerTools } from './tools';
import type { TabId } from '@otel-insights/types';

let receiver: OtlpReceiver | undefined;
let store: TelemetryStore | undefined;
let statusBarItem: vscode.StatusBarItem;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const dbPath = path.join(context.globalStorageUri.fsPath, 'telemetry.db');
  store = new TelemetryStore(dbPath);
  await store.initialize();

  const port = vscode.workspace
    .getConfiguration('otelInsights')
    .get<number>('port', 4318);

  receiver = new OtlpReceiver(store, port);

  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBarItem.command = 'otel-insights.openPanel';
  context.subscriptions.push(statusBarItem);

  try {
    await receiver.start();
    statusBarItem.text    = `$(broadcast) OTel :${port}`;
    statusBarItem.tooltip = `OTel Insights — OTLP/HTTP receiver on 127.0.0.1:${port}\nClick to open panel`;
  } catch (err) {
    statusBarItem.text    = `$(error) OTel`;
    statusBarItem.tooltip = `OTel Insights — receiver failed to start: ${err}`;
    vscode.window.showWarningMessage(
      `OTel Insights: Could not start OTLP receiver on port ${port}. ${err}`,
    );
  }
  statusBarItem.show();

  const navProvider = new OtelNavProvider();
  const navView = vscode.window.createTreeView('otelInsightsNav', {
    treeDataProvider: navProvider,
  });
  // Keep the sidebar selection in sync with in-webview navigation (e.g. clicking
  // a trace link jumps to the Traces view, so highlight Traces in the sidebar).
  OtelInsightsPanel.onTabChange = (tab: TabId) => {
    const entry = navEntryFor(tab);
    if (entry && navView.visible) {
      navView.reveal(entry, { select: true, focus: false }).then(undefined, () => { /* ignore */ });
    }
  };

  context.subscriptions.push(
    navView,
    vscode.commands.registerCommand('otel-insights.showTab', (tab: TabId) => {
      OtelInsightsPanel.createOrShow(context.extensionUri, store!, port);
      OtelInsightsPanel.currentPanel?.showTab(tab);
    }),
    vscode.commands.registerCommand('otel-insights.openPanel', () => {
      OtelInsightsPanel.createOrShow(context.extensionUri, store!, port);
    }),
    vscode.commands.registerCommand('otel-insights.clearData', () => {
      store!.clear();
      vscode.window.showInformationMessage('OTel Insights: All telemetry data cleared.');
      OtelInsightsPanel.currentPanel?.refresh();
    }),
    vscode.commands.registerCommand('otel-insights.navigateToTrace', (traceId: string, spanId?: string) => {
      OtelInsightsPanel.createOrShow(context.extensionUri, store!, port);
      OtelInsightsPanel.currentPanel?.navigateToTrace(traceId, spanId);
    }),
    vscode.window.registerUriHandler({
      handleUri(uri: vscode.Uri) {
        if (uri.path === '/navigate') {
          const params = new URLSearchParams(uri.query);
          const traceId = params.get('traceId');
          const spanId  = params.get('spanId') ?? undefined;
          if (traceId) {
            OtelInsightsPanel.createOrShow(context.extensionUri, store!, port);
            OtelInsightsPanel.currentPanel?.navigateToTrace(traceId, spanId);
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
