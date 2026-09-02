import * as vscode from 'vscode';
import { configurationTarget, isLoopbackHostname } from './configuration';

const CLAUDE_ENABLED = 'chat.agentHost.claudeAgent.enabled';
const CODEX_ENABLED = 'chat.agentHost.codexAgent.enabled';
const AGENT_HOST_OTEL_ENABLED = 'chat.agentHost.otel.enabled';
const AGENT_HOST_CAPTURE_CONTENT = 'chat.agentHost.otel.captureContent';
const AGENT_HOST_ENDPOINT = 'chat.agentHost.otel.otlpEndpoint';
const COPILOT_OTEL_ENABLED = 'github.copilot.chat.otel.enabled';
const COPILOT_CAPTURE_CONTENT = 'github.copilot.chat.otel.captureContent';
const COPILOT_ENDPOINT = 'github.copilot.chat.otel.otlpEndpoint';
const AGENT_INSIGHTS_PORT = 'agentInsights.port';

type SetupAction =
  | 'toggleClaude'
  | 'toggleCodex'
  | 'toggleAgentHostOtel'
  | 'editAgentHostEndpoint'
  | 'toggleCopilotOtel'
  | 'editCopilotEndpoint'
  | 'toggleCaptureContent'
  | 'editPort'
  | 'done';

interface SetupItem extends vscode.QuickPickItem {
  action?: SetupAction;
}

function booleanItem(
  action: SetupAction,
  label: string,
  key: string,
  detail: string,
): SetupItem {
  const config = vscode.workspace.getConfiguration();
  const info = config.inspect<boolean>(key);
  if (!info) {
    return {
      action,
      label: `$(warning) ${label}`,
      description: 'Unavailable',
      detail: `This setting is not available in the current VS Code build. ${detail}`,
    };
  }
  const enabled = config.get<boolean>(key, false);
  return {
    action,
    label: `${enabled ? '$(pass-filled)' : '$(circle-large-outline)'} ${label}`,
    description: enabled ? 'Enabled' : 'Disabled',
    detail,
  };
}

function valueItem(
  action: SetupAction,
  label: string,
  key: string,
  fallback: string | number,
  detail: string,
): SetupItem {
  const config = vscode.workspace.getConfiguration();
  const info = config.inspect<string | number>(key);
  return {
    action,
    label: `${info ? '$(edit)' : '$(warning)'} ${label}`,
    description: info ? String(config.get<string | number>(key, fallback)) : 'Unavailable',
    detail: info ? detail : `This setting is not available in the current VS Code build. ${detail}`,
  };
}

function captureContentItem(): SetupItem {
  const config = vscode.workspace.getConfiguration();
  const hostInfo = config.inspect<boolean>(AGENT_HOST_CAPTURE_CONTENT);
  const copilotInfo = config.inspect<boolean>(COPILOT_CAPTURE_CONTENT);
  const values = [
    ...(hostInfo ? [config.get<boolean>(AGENT_HOST_CAPTURE_CONTENT, false)] : []),
    ...(copilotInfo ? [config.get<boolean>(COPILOT_CAPTURE_CONTENT, false)] : []),
  ];
  const available = values.length > 0;
  const allEnabled = available && values.every(Boolean);
  const allDisabled = available && values.every(value => !value);
  const description = allEnabled ? 'Enabled' : (allDisabled ? 'Disabled' : 'Mixed');
  return {
    action: 'toggleCaptureContent',
    label: `${allEnabled ? '$(pass-filled)' : '$(circle-large-outline)'} Capture content`,
    description: available ? description : 'Unavailable',
    detail: available
      ? 'Include prompts, responses, tool arguments, and file contents from enabled telemetry sources.'
      : 'Content capture settings are not available in the current VS Code build.',
  };
}

function setupItems(): SetupItem[] {
  return [
    { label: 'Required', kind: vscode.QuickPickItemKind.Separator },
    booleanItem(
      'toggleAgentHostOtel',
      'Agent Host OpenTelemetry',
      AGENT_HOST_OTEL_ENABLED,
      'Export native Agent Host telemetry to Agent Insights.',
    ),
    valueItem(
      'editAgentHostEndpoint',
      'Agent Host OTLP endpoint',
      AGENT_HOST_ENDPOINT,
      `http://localhost:${vscode.workspace.getConfiguration('agentInsights').get<number>('port', 4318)}`,
      'The endpoint used by Agent Host telemetry.',
    ),
    { label: 'Providers', kind: vscode.QuickPickItemKind.Separator },
    booleanItem(
      'toggleClaude',
      'Claude Code',
      CLAUDE_ENABLED,
      'Enable Claude Code sessions in Agent Host.',
    ),
    booleanItem(
      'toggleCodex',
      'Codex',
      CODEX_ENABLED,
      'Enable Codex sessions in Agent Host.',
    ),
    booleanItem(
      'toggleCopilotOtel',
      'Copilot OpenTelemetry',
      COPILOT_OTEL_ENABLED,
      'Export additional Copilot metrics and logs.',
    ),
    valueItem(
      'editCopilotEndpoint',
      'Copilot OTLP endpoint',
      COPILOT_ENDPOINT,
      `http://localhost:${vscode.workspace.getConfiguration('agentInsights').get<number>('port', 4318)}`,
      'The endpoint used by Copilot telemetry.',
    ),
    { label: 'Optional', kind: vscode.QuickPickItemKind.Separator },
    captureContentItem(),
    valueItem(
      'editPort',
      'Agent Insights receiver port',
      AGENT_INSIGHTS_PORT,
      4318,
      'The local port on which Agent Insights receives OTLP/HTTP telemetry.',
    ),
    { label: '', kind: vscode.QuickPickItemKind.Separator },
    {
      action: 'done',
      label: '$(check) Done',
      detail: 'Close setup.',
    },
  ];
}

async function updateSetting<T>(key: string, value: T): Promise<boolean> {
  const config = vscode.workspace.getConfiguration();
  const info = config.inspect<T>(key);
  if (!info) {
    await vscode.window.showWarningMessage(
      `Agent Insights: "${key}" is not available in this VS Code build.`,
    );
    return false;
  }
  const target = key === AGENT_INSIGHTS_PORT
    ? configurationTarget(info)
    : vscode.ConfigurationTarget.Global;
  await config.update(key, value, target);
  return true;
}

async function toggleSetting(key: string): Promise<boolean> {
  const current = vscode.workspace.getConfiguration().get<boolean>(key, false);
  return updateSetting(key, !current);
}

function validateEndpoint(value: string): string | undefined {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return 'Enter a valid URL, such as http://localhost:4318.';
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return 'The endpoint must use http or https.';
  }
  return undefined;
}

async function editEndpoint(key: string, title: string): Promise<boolean> {
  const config = vscode.workspace.getConfiguration();
  if (!config.inspect<string>(key)) {
    await vscode.window.showWarningMessage(
      `Agent Insights: "${key}" is not available in this VS Code build.`,
    );
    return false;
  }
  const port = config.get<number>(AGENT_INSIGHTS_PORT, 4318);
  const value = await vscode.window.showInputBox({
    title,
    prompt: 'Enter the OTLP/HTTP endpoint used to send telemetry to Agent Insights.',
    value: config.get<string>(key, `http://localhost:${port}`),
    validateInput: validateEndpoint,
  });
  return value === undefined ? false : updateSetting(key, value);
}

async function editPort(): Promise<boolean> {
  const config = vscode.workspace.getConfiguration();
  const value = await vscode.window.showInputBox({
    title: 'Agent Insights receiver port',
    prompt: 'Every OTLP endpoint must use this same port.',
    value: String(config.get<number>(AGENT_INSIGHTS_PORT, 4318)),
    validateInput: input => {
      const port = Number(input);
      return Number.isInteger(port) && port >= 1 && port <= 65535
        ? undefined
        : 'Enter a whole number from 1 to 65535.';
    },
  });
  if (value === undefined) { return false; }

  const port = Number(value);
  const portChanged = await updateSetting(AGENT_INSIGHTS_PORT, port);
  if (!portChanged) { return false; }

  await Promise.all([
    updateLocalEndpointPort(AGENT_HOST_ENDPOINT, port),
    updateLocalEndpointPort(COPILOT_ENDPOINT, port),
  ]);
  return true;
}

async function toggleCaptureContent(): Promise<boolean> {
  const config = vscode.workspace.getConfiguration();
  const available = [
    ...(config.inspect<boolean>(AGENT_HOST_CAPTURE_CONTENT) ? [AGENT_HOST_CAPTURE_CONTENT] : []),
    ...(config.inspect<boolean>(COPILOT_CAPTURE_CONTENT) ? [COPILOT_CAPTURE_CONTENT] : []),
  ];
  const next = !available.every(key => config.get<boolean>(key, false));
  const updates: Promise<boolean>[] = [];
  if (!available.length) {
    await vscode.window.showWarningMessage(
      'Agent Insights: content capture settings are not available in this VS Code build.',
    );
    return false;
  }
  for (const key of available) {
    updates.push(updateSetting(key, next));
  }
  const results = await Promise.all(updates);
  return results.some(Boolean);
}

async function updateLocalEndpointPort(key: string, port: number): Promise<boolean> {
  const config = vscode.workspace.getConfiguration();
  const current = config.get<string>(key);
  if (!config.inspect<string>(key) || !current) { return false; }

  let url: URL;
  try {
    url = new URL(current);
  } catch {
    return false;
  }
  if (!isLoopbackHostname(url.hostname) || url.port === String(port)) { return false; }

  url.port = String(port);
  return updateSetting(key, url.toString().replace(/\/$/, ''));
}

/** Show all Agent Insights prerequisites and related settings in one native menu. */
export async function showAgentInsightsSetup(): Promise<void> {
  let changed = false;
  while (true) {
    const picked = await vscode.window.showQuickPick(setupItems(), {
      title: 'Agent Insights Setup',
      placeHolder: 'Select a setting to change',
      matchOnDescription: true,
      matchOnDetail: true,
    });
    if (!picked || picked.action === 'done') { break; }

    switch (picked.action) {
      case 'toggleClaude':
        changed = await toggleSetting(CLAUDE_ENABLED) || changed;
        break;
      case 'toggleCodex':
        changed = await toggleSetting(CODEX_ENABLED) || changed;
        break;
      case 'toggleAgentHostOtel':
        changed = await toggleSetting(AGENT_HOST_OTEL_ENABLED) || changed;
        break;
      case 'editAgentHostEndpoint':
        changed = await editEndpoint(AGENT_HOST_ENDPOINT, 'Agent Host OTLP endpoint') || changed;
        break;
      case 'toggleCopilotOtel':
        changed = await toggleSetting(COPILOT_OTEL_ENABLED) || changed;
        break;
      case 'editCopilotEndpoint':
        changed = await editEndpoint(COPILOT_ENDPOINT, 'Copilot OTLP endpoint') || changed;
        break;
      case 'toggleCaptureContent':
        changed = await toggleCaptureContent() || changed;
        break;
      case 'editPort':
        changed = await editPort() || changed;
        break;
    }
  }

  if (!changed) { return; }
  const answer = await vscode.window.showInformationMessage(
    'Agent Insights setup updated. Reload VS Code to apply Agent Host changes.',
    'Reload Window',
  );
  if (answer === 'Reload Window') {
    await vscode.commands.executeCommand('workbench.action.reloadWindow');
  }
}
