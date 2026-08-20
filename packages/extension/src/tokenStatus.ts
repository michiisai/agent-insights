import * as vscode from 'vscode';
import {
  formatTokenSparkline,
  getTokenTrendWindow,
} from '@agent-insights/engine';
import type { DailyTokenUsage, TokenTrend } from '@agent-insights/types';
import type { TelemetryDatabase } from './database/service';
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
  private refreshInFlight = false;
  private disposed = false;

  constructor(
    private readonly item: vscode.StatusBarItem,
    private readonly database: TelemetryDatabase,
  ) {
    this.timer = setInterval(() => { void this.refresh(); }, REFRESH_INTERVAL_MS);
  }

  setListening(port: number): void {
    this.listeningPort = port;
    this.lastTokenVersion = -1;
    this.lastDayKey = '';
    this.lastVisibilityKey = '';
    this.lastTrendKey = '';
    void this.refresh();
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
    void this.refresh();
  }

  private async refresh(): Promise<void> {
    const port = this.listeningPort;
    if (
      this.disposed
      || port === undefined
      || !this.database.isWritable
      || this.refreshInFlight
    ) { return; }

    const day = getLocalDayBounds();
    const trendWindow = getTokenTrendWindow();
    const visibility = getModelVisibility();
    const visibilityKey = modelVisibilityKey(visibility);

    this.refreshInFlight = true;
    try {
      const result = await this.database.request('getTokenStatus', {
        daySinceNano: day.sinceNano,
        dayUntilNano: day.untilNano,
        trendSinceNano: trendWindow.sinceNano,
        trendUntilNano: trendWindow.untilNano,
        visibility,
      });
      if (
        !result.writable
        || this.disposed
        || this.listeningPort !== port
        || !this.database.isWritable
      ) { return; }
      if (
        result.tokenFactsVersion === this.lastTokenVersion
        && day.key === this.lastDayKey
        && visibilityKey === this.lastVisibilityKey
        && trendWindow.key === this.lastTrendKey
      ) { return; }

      this.item.text = formatStatusText(result.usage, port);
      this.item.tooltip = buildTokenTooltip(result.usage, result.trend, day, port);
      this.lastTokenVersion = result.tokenFactsVersion;
      this.lastDayKey = day.key;
      this.lastVisibilityKey = visibilityKey;
      this.lastTrendKey = trendWindow.key;
    } catch (error) {
      console.error('Agent Insights: failed to refresh daily token status', error);
      this.item.text = `$(warning) Agent :${port}`;
      this.item.tooltip = `Agent Insights — receiver is running on 127.0.0.1:${port}, `
        + `but daily token usage could not be refreshed: ${error}`;
    } finally {
      this.refreshInFlight = false;
    }
  }

  dispose(): void {
    this.disposed = true;
    clearInterval(this.timer);
  }
}
