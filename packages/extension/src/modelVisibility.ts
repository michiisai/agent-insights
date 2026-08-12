import * as vscode from 'vscode';
import {
  DEFAULT_UTILITY_MODEL_PATTERNS,
  type ModelVisibilityOptions,
} from '@agent-insights/types';

const CONFIGURATION_SECTION = 'agentInsights';
const HIDE_UTILITY_MODELS = 'hideUtilityModels';
const UTILITY_MODELS = 'utilityModels';

export function getModelVisibility(): ModelVisibilityOptions {
  const config = vscode.workspace.getConfiguration(CONFIGURATION_SECTION);
  const configuredPatterns = config.get<unknown[]>(UTILITY_MODELS, [...DEFAULT_UTILITY_MODEL_PATTERNS]);
  const utilityModels = configuredPatterns
    .filter((pattern): pattern is string => typeof pattern === 'string')
    .map(pattern => pattern.trim())
    .filter(Boolean);

  return {
    hideUtilityModels: config.get<boolean>(HIDE_UTILITY_MODELS, true),
    utilityModels,
  };
}

export function modelVisibilityKey(options: ModelVisibilityOptions): string {
  const patterns = [...(options.utilityModels ?? [])]
    .map(pattern => pattern.trim().toLocaleLowerCase())
    .filter(Boolean)
    .sort();
  return `${options.hideUtilityModels === true ? '1' : '0'}:${patterns.join('\u001f')}`;
}
