import * as vscode from 'vscode';

/** Preserve the scope where a setting is already defined instead of shadowing it. */
export function configurationTarget(
  info: ReturnType<vscode.WorkspaceConfiguration['inspect']>,
): vscode.ConfigurationTarget {
  if (info?.workspaceFolderValue !== undefined) { return vscode.ConfigurationTarget.WorkspaceFolder; }
  if (info?.workspaceValue !== undefined)       { return vscode.ConfigurationTarget.Workspace; }
  return vscode.ConfigurationTarget.Global;
}

export function isLoopbackHostname(hostname: string): boolean {
  return hostname === 'localhost'
    || hostname === '127.0.0.1'
    || hostname === '::1'
    || hostname === '[::1]';
}
