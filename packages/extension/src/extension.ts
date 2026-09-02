import * as vscode from 'vscode';
import * as path from 'path';
import { AgentInsightsPanel } from './panel';
import { AgentNavProvider, navEntryFor } from './nav';
import { registerTools } from './tools';
import { TokenStatusController } from './tokenStatus';
import { CollectorCoordinator } from './collectorCoordinator';
import type { TabId } from '@agent-insights/types';
import { DatabaseClient } from './database/client';
import type { TelemetryDatabase } from './database/service';
import { configurationTarget, isLoopbackHostname } from './configuration';

let database: TelemetryDatabase | undefined;
let statusBarItem: vscode.StatusBarItem;
let tokenStatus: TokenStatusController;
let coordinator: CollectorCoordinator | undefined;

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

/** Offer to align a local exporter endpoint without editing settings silently. */
async function syncOtlpEndpoint(port: number): Promise<void> {
  const cfg     = vscode.workspace.getConfiguration();
  const info    = cfg.inspect<string>(ENDPOINT_SETTING);
  const current = cfg.get<string>(ENDPOINT_SETTING);
  // Unset means the user hasn't opted into agent-host telemetry; creating the
  // setting for them would be presumptuous.
  if (!info || !current) { return; }

  let url: URL;
  try { url = new URL(current); } catch { return; }
  if (!isLoopbackHostname(url.hostname) || url.port === String(port)) { return; }

  url.port = String(port);
  const target = url.toString().replace(/\/$/, '');
  const pick = await vscode.window.showWarningMessage(
    `Agent Insights is receiving on port ${port}, but "${ENDPOINT_SETTING}" points at ${current}. `
      + 'VS Code\'s agent telemetry will not reach the extension until they match.',
    `Update to ${target}`,
    'Not now',
  );
  if (pick?.startsWith('Update')) {
    await cfg.update(ENDPOINT_SETTING, target, configurationTarget(info));
    vscode.window.showInformationMessage(`Agent Insights: ${ENDPOINT_SETTING} set to ${target}. Reload VS Code for it to take effect.`);
  }
}

async function reportUnknownCollector(port: number): Promise<void> {
  const pick = await vscode.window.showWarningMessage(
    `Agent Insights: port ${port} is already in use by an unrecognized application or OTLP collector. `
      + `Set "agentInsights.port" to a free port (and match it in "${ENDPOINT_SETTING}").`,
    'Open Settings',
    'Retry',
  );
  if (pick === 'Open Settings') {
    await vscode.commands.executeCommand('workbench.action.openSettings', 'agentInsights.port');
  } else if (pick === 'Retry') {
    await coordinator?.restart(configuredPort());
  }
}

async function reportStartFailure(port: number, error: unknown): Promise<void> {
  const pick = await vscode.window.showWarningMessage(
    `Agent Insights: could not start the OTLP receiver on port ${port}. ${error}`,
    'Open Settings',
    'Retry',
  );
  if (pick === 'Open Settings') {
    await vscode.commands.executeCommand('workbench.action.openSettings', 'agentInsights.port');
  } else if (pick === 'Retry') {
    await coordinator?.restart(configuredPort());
  }
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const dbPath = path.join(context.globalStorageUri.fsPath, 'telemetry.db');
  database = await DatabaseClient.create(dbPath);

  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBarItem.command = 'agent-insights.openPanel';
  tokenStatus = new TokenStatusController(statusBarItem, database);
  context.subscriptions.push(statusBarItem, tokenStatus);

  coordinator = new CollectorCoordinator(database, tokenStatus, {
    onPortChange: port => {
      currentPort = port;
      AgentInsightsPanel.currentPanel?.updatePort(port);
    },
    onOwner: port => { void syncOtlpEndpoint(port); },
    onUnknownCollector: port => { void reportUnknownCollector(port); },
    onStartFailure: (port, error) => { void reportStartFailure(port, error); },
    onLifecycleError: error => console.error('Agent Insights: collector lifecycle error', error),
  });
  await coordinator.start(configuredPort());
  statusBarItem.show();

  const navProvider = new AgentNavProvider();
  const navView = vscode.window.createTreeView('agentInsightsNav', {
    treeDataProvider: navProvider,
  });
  AgentInsightsPanel.onTabChange = (tab: TabId) => {
    const entry = navEntryFor(tab);
    if (entry && navView.visible) {
      navView.reveal(entry, { select: true, focus: false }).then(undefined, () => { /* ignore */ });
    }
  };

  context.subscriptions.push(
    navView,
    // Rebind immediately when the configured receiver port changes.
    vscode.workspace.onDidChangeConfiguration(e => {
      if (
        e.affectsConfiguration('agentInsights.hideUtilityModels')
        || e.affectsConfiguration('agentInsights.utilityModels')
      ) {
        tokenStatus.refreshNow();
        AgentInsightsPanel.currentPanel?.refreshData();
      }
      if (!e.affectsConfiguration('agentInsights.port')) { return; }
      const next = configuredPort();
      void coordinator?.restart(next);
    }),
    vscode.commands.registerCommand('agent-insights.showTab', (tab: TabId) => {
      AgentInsightsPanel.createOrShow(context.extensionUri, database!, currentPort);
      AgentInsightsPanel.currentPanel?.showTab(tab);
    }),
    vscode.commands.registerCommand('agent-insights.openPanel', () => {
      AgentInsightsPanel.createOrShow(context.extensionUri, database!, currentPort);
    }),
    vscode.commands.registerCommand('agent-insights.clearData', async () => {
      // In a read-only window this would empty the view while the file (and the
      // owning window) kept the data — cleared until the next reload.
      if (!database!.isWritable) {
        vscode.window.showWarningMessage(
          'Agent Insights: this window is read-only because another window owns the OTLP port, so the data cannot be cleared from here. Use the window that is receiving telemetry.',
        );
        return;
      }
      await database!.clear();
      tokenStatus.refreshNow();
      vscode.window.showInformationMessage('Agent Insights: All telemetry data cleared.');
      AgentInsightsPanel.currentPanel?.refresh();
    }),
    vscode.commands.registerCommand('agent-insights.navigateToTrace', (traceId: string, spanId?: string) => {
      AgentInsightsPanel.createOrShow(context.extensionUri, database!, currentPort);
      AgentInsightsPanel.currentPanel?.navigateToTrace(traceId, spanId);
    }),
    vscode.commands.registerCommand('agent-insights.navigateToSession', (sessionId: string) => {
      AgentInsightsPanel.createOrShow(context.extensionUri, database!, currentPort);
      AgentInsightsPanel.currentPanel?.navigateToSession(sessionId);
    }),
    // A window reload restores the tab, but VS Code only hands it back through a
    // serializer; without one the restored panel stays blank forever.
    vscode.window.registerWebviewPanelSerializer(AgentInsightsPanel.viewType, {
      deserializeWebviewPanel(panel: vscode.WebviewPanel): Thenable<void> {
        AgentInsightsPanel.revive(panel, context.extensionUri, database!, currentPort);
        return Promise.resolve();
      },
    }),
    vscode.window.registerUriHandler({
      handleUri(uri: vscode.Uri) {
        if (uri.path === '/navigate') {
          const params = new URLSearchParams(uri.query);
          const sessionId = params.get('sessionId');
          const traceId = params.get('traceId');
          const spanId  = params.get('spanId') ?? undefined;
          if (sessionId) {
            AgentInsightsPanel.createOrShow(context.extensionUri, database!, currentPort);
            AgentInsightsPanel.currentPanel?.navigateToSession(sessionId);
          } else if (traceId) {
            AgentInsightsPanel.createOrShow(context.extensionUri, database!, currentPort);
            AgentInsightsPanel.currentPanel?.navigateToTrace(traceId, spanId);
          }
        }
      },
    }),
  );

  registerTools(context, database, () => {
    AgentInsightsPanel.currentPanel?.notifyChatToolInvoked();
  });
}

export async function deactivate(): Promise<void> {
  tokenStatus?.dispose();
  await coordinator?.shutdown();
  coordinator = undefined;
  database = undefined;
}
