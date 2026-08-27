'use strict';

const Module = require('module');
const path = require('path');
const esbuild = require('esbuild');
const { check } = require('../lib/assert');

function loadTools(vscode) {
  const entry = path.resolve(__dirname, '../../packages/extension/src/tools.ts');
  const output = esbuild.buildSync({
    entryPoints: [entry],
    bundle: true,
    external: ['vscode'],
    format: 'cjs',
    platform: 'node',
    target: 'node20',
    write: false,
  })?.outputFiles?.[0]?.text;
  if (!output) { throw new Error('Failed to compile transcript tool'); }

  const originalLoad = Module._load;
  const compiled = new Module(entry, module);
  compiled.filename = entry;
  compiled.paths = Module._nodeModulePaths(path.dirname(entry));
  try {
    Module._load = (request, parent, isMain) =>
      request === 'vscode' ? vscode : originalLoad(request, parent, isMain);
    compiled._compile(output, entry);
    return compiled.exports;
  } finally {
    Module._load = originalLoad;
  }
}

function turn(index, parts, prompt = `prompt ${index}`) {
  return {
    traceId: `trace-${index}`,
    spanId: `span-${index}`,
    sourceSpanId: null,
    spanName: 'chat',
    startTimeUnixNano: `${index}000000`,
    model: 'gpt-5',
    hasError: false,
    outputMessages: JSON.stringify([{ role: 'assistant', parts }]),
    inputPreview: prompt,
    inputContextMessages: '[]',
    systemInstructions: '[]',
    details: [],
    isSubagent: false,
    subagentType: null,
    subagentId: null,
  };
}

async function sessionTranscriptToolChecks() {
  const registered = new Map();
  class LanguageModelTextPart {
    constructor(value) { this.value = value; }
  }
  class LanguageModelToolResult {
    constructor(content) { this.content = content; }
  }
  const vscode = {
    env: { uriScheme: 'vscode-insiders' },
    LanguageModelTextPart,
    LanguageModelToolResult,
    lm: {
      registerTool(name, tool) {
        registered.set(name, tool);
        return { dispose() {} };
      },
    },
  };
  const toolMessages = {
    sessionId: 'tool-session',
    captureEnabled: true,
    turns: [
      turn(1, [
        { type: 'tool_call', id: 'call-1', name: 'Read', arguments: '{"path":"a.ts"}' },
        { type: 'tool_call_response', id: 'call-1', response: 'file contents' },
      ]),
      turn(2, []),
    ],
  };
  const longText = 'x'.repeat(8_000);
  const budgetMessages = {
    sessionId: 'budget-session',
    captureEnabled: true,
    turns: Array.from({ length: 25 }, (_, index) =>
      turn(index + 1, [{ type: 'text', content: longText }], longText)),
  };
  const database = {
    request(operation, input) {
      if (operation !== 'getSessionMessages') { return Promise.resolve([]); }
      if (input.sessionId === 'budget-session') { return Promise.resolve(budgetMessages); }
      if (input.sessionId === 'empty-session') {
        return Promise.resolve({ sessionId: 'empty-session', captureEnabled: false, turns: [] });
      }
      return Promise.resolve(toolMessages);
    },
  };
  const context = { subscriptions: [] };
  loadTools(vscode).registerTools(context, database);
  const tool = registered.get('agent-insights_getSessionMessages');
  if (!tool) { throw new Error('Transcript tool was not registered'); }
  const token = {
    isCancellationRequested: false,
    onCancellationRequested: () => ({ dispose() {} }),
  };

  const result = await tool.invoke({ input: { sessionId: 'tool-session' } }, token);
  const text = result.content[0].value;
  check(text.includes('**Tool activity (2):**'), 'LM transcript includes tool calls and results');
  check(text.includes('`Read result`: file contents'), 'LM transcript labels a tool result with its call');
  check(text.includes('no prose captured; this model call contains tool activity'),
    'LM transcript describes a textless tool call without claiming no uncaptured prose');
  check(text.includes('no prose was captured or exported'),
    'LM transcript distinguishes a turn whose assistant prose is unavailable');
  check(!text.includes('model replied with tool calls only'),
    'LM transcript does not make the unsupported tool-only claim');

  const budgetResult = await tool.invoke({
    input: {
      sessionId: 'budget-session',
      turnCount: 25,
      maxCharsPerTurn: 6_000,
    },
  }, token);
  const budgetText = budgetResult.content[0].value;
  check(budgetText.length < 42_000, 'LM transcript stops before exceeding its output budget');
  check(budgetText.includes('Output budget reached'), 'LM transcript explains how to page after its budget');

  const emptyResult = await tool.invoke({ input: { sessionId: 'empty-session' } }, token);
  const emptyText = emptyResult.content[0].value;
  check(emptyText.includes('No supported message records were found'),
    'LM transcript does not equate missing records with disabled capture');
  check(!emptyText.includes('recorded this session with content capture disabled'),
    'LM transcript avoids an unsupported diagnosis for empty sessions');
}

module.exports = { sessionTranscriptToolChecks };
