import * as vscode from 'vscode';
import {
  formatTokenSparkline,
  getDailyTokenUsage,
  getTokenTrend,
  getTokenTrendWindow,
} from '@agent-insights/engine';
import type { TelemetryStore } from '@agent-insights/receiver';
import type { DailyTokenUsage, TokenTrend } from '@agent-insights/types';
import { getModelVisibility, modelVisibilityKey } from './modelVisibility';

const REFRESH_INTERVAL_MS = 5_000;
const tooltipNumber = new Intl.NumberFormat(undefined, {
  notation: 'compact',
  compactDisplay: 'short',
  maximumSignificantDigits: 3,
});

export interface LocalDayBounds {
  key: string;
  label: string;
  sinceNano: string;
  untilNano: string;
}

export function getLocalDayBounds(now = new Date()): LocalDayBounds {
  const year = now.getFullYear();
  const month = now.getMonth();
  const day = now.getDate();
  const start = new Date(year, month, day);
  const end = new Date(year, month, day + 1);
  return {
    key: `${year}-${month + 1}-${day}@${now.getTimezoneOffset()}`,
    label: now.toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    }),
    sinceNano: `${start.getTime()}000000`,
    untilNano: `${end.getTime()}000000`,
  };
}

export function formatCompactTokens(value: number): string {
  const amount = Math.max(0, Math.round(value));
  if (amount < 1_000) { return String(amount); }
  if (amount < 10_000) { return `${(amount / 1_000).toFixed(1)}K`; }
  if (amount < 999_950) { return `${Math.round(amount / 100) / 10}K`; }
  if (amount < 10_000_000) { return `${(amount / 1_000_000).toFixed(1)}M`; }
  return `${Math.round(amount / 100_000) / 10}M`;
}

export function formatCacheRate(rate: number): string {
  return rate < 0 ? '—' : `${Math.round(rate * 100)}%`;
}

export function formatTooltipTokens(value: number): string {
  return tooltipNumber.format(Math.max(0, Math.round(value)));
}

function formatTrendCell(input: readonly number[]): string {
  return formatTokenSparkline(input);
}

export function formatStatusText(usage: DailyTokenUsage, port: number): string {
  if (usage.callCount === 0) { return `$(broadcast) Agent :${port}`; }
  return `$(broadcast) ↓${formatCompactTokens(usage.inputTokens)} `
    + `${formatCacheRate(usage.cacheHitRate)} `
    + `↑${formatCompactTokens(usage.outputTokens)}`;
}

function escapeMarkdownCell(value: string): string {
  return value
    .replace(/([\\`*_[\]{}()#+.!|<>])/g, '\\$1')
    .replace(/\r?\n/g, ' ');
}

export function buildTokenTooltip(
  usage: DailyTokenUsage,
  trend: TokenTrend,
  day: LocalDayBounds,
  port: number,
): vscode.MarkdownString {
  const lines = [
    `### Observed tokens today · ${day.label}`,
  ];

  const hasTrend = trend.inputTokens.some(Boolean);
  if (usage.models.length || hasTrend) {
    const trendByModel = new Map(trend.models.map(model => [model.model, model]));
    lines.push(
      '',
      '| Model | Input | Cached | Output | Calls | 12h input |',
      '|:--|--:|--:|--:|--:|:--|',
      `| **Total** | **${formatTooltipTokens(usage.inputTokens)}** `
        + `| **${formatCacheRate(usage.cacheHitRate)}** `
        + `| **${formatTooltipTokens(usage.outputTokens)}** `
        + `| **${formatTooltipTokens(usage.callCount)}** `
        + `| ${formatTrendCell(trend.inputTokens)} |`,
      ...usage.models.map(model => {
        const modelTrend = trendByModel.get(model.model);
        const inputTrend = modelTrend?.inputTokens ?? [0, 0, 0, 0, 0, 0];
        return `| ${escapeMarkdownCell(model.model)} `
          + `| ${formatTooltipTokens(model.inputTokens)} `
          + `| ${formatCacheRate(model.cacheHitRate)} `
          + `| ${formatTooltipTokens(model.outputTokens)} `
          + `| ${formatTooltipTokens(model.callCount)} `
          + `| ${formatTrendCell(inputTrend)} |`;
      }),
    );
  } else {
    lines.push('', '_No token-bearing model calls received today._');
  }

  lines.push(
    '',
    `OTLP/HTTP receiver: \`127.0.0.1:${port}\`  `,
    'Updates within 5 seconds · Click to open Agent Insights',
    '',
    '_Observed OpenTelemetry usage may differ from provider billing._',
  );

  const tooltip = new vscode.MarkdownString(lines.join('\n'));
  tooltip.isTrusted = false;
  tooltip.supportHtml = false;
  return tooltip;
}

export class TokenStatusController implements vscode.Disposable {
  private timer: ReturnType<typeof setInterval>;
  private listeningPort?: number;
  private lastTokenVersion = -1;
  private lastDayKey = '';
  private lastVisibilityKey = '';
  private lastTrendKey = '';

  constructor(
    private readonly item: vscode.StatusBarItem,
    private readonly store: TelemetryStore,
  ) {
    this.timer = setInterval(() => this.refresh(), REFRESH_INTERVAL_MS);
  }

  setListening(port: number): void {
    this.listeningPort = port;
    this.lastTokenVersion = -1;
    this.lastDayKey = '';
    this.lastVisibilityKey = '';
    this.lastTrendKey = '';
    this.refresh();
  }

  setFollowing(port: number): void {
    this.listeningPort = undefined;
    this.item.text = '$(plug) Agent';
    this.item.tooltip = `Agent Insights — another VS Code window is collecting and displaying live telemetry on 127.0.0.1:${port}, including telemetry from this window.\n`
      + 'This window only shows a startup snapshot and will not update unless it becomes the collector.';
  }

  setReconnecting(port: number): void {
    this.listeningPort = undefined;
    this.item.text = '$(sync~spin) Agent';
    this.item.tooltip = `Agent Insights — the collector on port ${port} disconnected. Attempting to take over…`;
  }

  setUnknownCollector(port: number): void {
    this.listeningPort = undefined;
    this.item.text = '$(warning) Agent';
    this.item.tooltip = `Agent Insights — port ${port} is owned by an unrecognized application or collector.`;
  }

  setReceiverError(port: number, error: unknown): void {
    this.listeningPort = undefined;
    this.item.text = '$(error) Agent';
    this.item.tooltip = `Agent Insights — receiver failed to start on port ${port}: ${error}\n`
      + 'Open the Agent Insights settings to choose another port, then retry.';
  }

  refreshNow(): void {
    this.lastTokenVersion = -1;
    this.refresh();
  }

  private refresh(): void {
    const port = this.listeningPort;
    if (port === undefined || !this.store.isWritable) { return; }

    const day = getLocalDayBounds();
    const trendWindow = getTokenTrendWindow();
    const version = this.store.getTokenFactsVersion();
    const visibility = getModelVisibility();
    const visibilityKey = modelVisibilityKey(visibility);
    if (
      version === this.lastTokenVersion
      && day.key === this.lastDayKey
      && visibilityKey === this.lastVisibilityKey
      && trendWindow.key === this.lastTrendKey
    ) { return; }

    try {
      const usage = getDailyTokenUsage(
        this.store.getDb(),
        day.sinceNano,
        day.untilNano,
        visibility,
      );
      const trend = getTokenTrend(
        this.store.getDb(),
        trendWindow.sinceNano,
        trendWindow.untilNano,
        visibility,
      );
      this.item.text = formatStatusText(usage, port);
      this.item.tooltip = buildTokenTooltip(usage, trend, day, port);
      this.lastTokenVersion = version;
      this.lastDayKey = day.key;
      this.lastVisibilityKey = visibilityKey;
      this.lastTrendKey = trendWindow.key;
    } catch (error) {
      console.error('Agent Insights: failed to refresh daily token status', error);
      this.item.text = `$(warning) Agent :${port}`;
      this.item.tooltip = `Agent Insights — receiver is running on 127.0.0.1:${port}, `
        + `but daily token usage could not be refreshed: ${error}`;
    }
  }

  dispose(): void {
    clearInterval(this.timer);
  }
}
