import * as vscode from 'vscode';
import type { TabId } from '@agent-insights/types';

interface NavEntry {
  id: TabId;
  label: string;
  icon: string;
}

/** Activity-bar navigation order. */
const NAV_ENTRIES: NavEntry[] = [
  { id: 'home',     label: 'Home',     icon: 'home' },
  { id: 'sessions', label: 'Sessions', icon: 'comment-discussion' },
  { id: 'traces',   label: 'Traces',   icon: 'list-tree' },
  { id: 'metrics',  label: 'Metrics',  icon: 'graph' },
  { id: 'logs',     label: 'Logs',     icon: 'output' },
];

/** Return the stable entry used by `TreeView.reveal`. */
export function navEntryFor(id: TabId): NavEntry | undefined {
  return NAV_ENTRIES.find(e => e.id === id);
}

export class AgentNavProvider implements vscode.TreeDataProvider<NavEntry> {
  getTreeItem(entry: NavEntry): vscode.TreeItem {
    const item = new vscode.TreeItem(entry.label, vscode.TreeItemCollapsibleState.None);
    item.id       = entry.id;
    item.iconPath = new vscode.ThemeIcon(entry.icon);
    item.tooltip  = `Open ${entry.label}`;
    item.command  = {
      command:   'agent-insights.showTab',
      title:     `Open ${entry.label}`,
      arguments: [entry.id],
    };
    return item;
  }

  getChildren(): NavEntry[] {
    return NAV_ENTRIES;
  }

  getParent(): undefined {
    return undefined;
  }
}
