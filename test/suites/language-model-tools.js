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

async function languageModelToolChecks() {
  const registered = new Map();
  class LanguageModelTextPart {
    constructor(value) { this.value = value; }
  }
  class LanguageModelToolResult {
    constructor(content) { this.content = content; }
  }
  const vscode = {
    env: { uriScheme: 'vscode-insiders' },
    workspace: {
      getConfiguration: () => ({ get: (_key, fallback) => fallback }),
    },
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
  const errorTrace = {
    traceId: 'error-trace',
    rootSpanName: 'failed operation',
    serviceName: 'test-service',
    startTimeUnixNano: '1000000',
    durationMs: 1,
    spanCount: 1,
    hasError: true,
  };
  const largeTraceSpans = Array.from({ length: 300 }, (_, index) => ({
    traceId: 'large-trace',
    spanId: `span-${index + 1}`,
    parentSpanId: index === 0 ? null : 'span-1',
    name: `operation ${index + 1}`,
    serviceName: 'codex-app-server',
    startTimeUnixNano: `${index + 1}000000`,
    durationMs: 1,
    statusCode: 0,
    statusMessage: '',
    kind: 1,
    attributes: {},
  }));
  largeTraceSpans[250].name = 'late failure';
  largeTraceSpans[250].statusCode = 2;
  largeTraceSpans[275].name = 'late slow operation';
  largeTraceSpans[275].durationMs = 9_000;
  largeTraceSpans[280].name = 'handle_responses';
  largeTraceSpans[280].attributes = {
    'gen_ai.usage.input_tokens': 2_000,
    'gen_ai.usage.output_tokens': 1_000,
  };
  largeTraceSpans[285].name = 'execute_tool Read';
  largeTraceSpans[285].attributes = { 'gen_ai.tool.name': 'Read' };
  largeTraceSpans[299].name = 'final operation';
  const budgetTraceSpans = Array.from({ length: 100 }, (_, index) => ({
    ...largeTraceSpans[index],
    traceId: 'budget-trace',
    attributes: {
      'exception.type': 'x'.repeat(400),
      'exception.message': 'x'.repeat(400),
      'exception.stacktrace': 'x'.repeat(400),
      'gen_ai.request.model': 'x'.repeat(400),
      'gen_ai.tool.name': 'x'.repeat(400),
      'http.method': 'x'.repeat(400),
      'http.url': 'x'.repeat(400),
      'http.status_code': 'x'.repeat(400),
      'db.system': 'x'.repeat(400),
      'db.statement': 'x'.repeat(400),
      'rpc.method': 'x'.repeat(400),
      'rpc.service': 'x'.repeat(400),
    },
  }));
  const database = {
    request(operation, input) {
      if (operation === 'getSessions') {
        return Promise.resolve([{
          sessionId: 'listed-session',
          agent: 'codex',
          serviceName: 'codex-app-server',
          hasError: false,
          traceCount: 2,
          models: ['gpt-5'],
        }]);
      }
      if (operation === 'getTraces') {
        return Promise.resolve(input.errorsOnly ? [errorTrace] : []);
      }
      if (operation === 'getTraceDetails') {
        return Promise.resolve({
          spans: input.traceId === 'budget-trace' ? budgetTraceSpans : largeTraceSpans,
          sessionId: null,
        });
      }
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

  const traceListTool = registered.get('agent-insights_listTraces');
  const errorTraceResult = await traceListTool.invoke({
    input: { errorsOnly: true, limit: 1 },
  }, token);
  const errorTraceText = errorTraceResult.content[0].value;
  check(errorTraceText.includes('`error-trace`'),
    'LM trace list applies errorsOnly before the database limit');

  const traceTool = registered.get('agent-insights_getTrace');
  const traceResult = await traceTool.invoke({ input: { traceId: 'large-trace' } }, token);
  const traceText = traceResult.content[0].value;
  check(traceText.includes('## Span Detail (1–50 of 300)'),
    'LM trace detail defaults to the first 50 spans');
  check((traceText.match(/spanId: /g) || []).length === 50,
    'LM trace detail renders only its requested span window');
  check(traceText.includes('fromSpan=51'),
    'LM trace detail provides the next page index');
  check(traceText.includes('Do not page through them to summarize this trace')
      && traceText.includes('only if the user explicitly requested exhaustive sequential inspection'),
    'LM trace detail reserves paging for explicit exhaustive inspection');
  check(traceText.length < 42_000, 'LM trace detail stays within its output budget');
  check(traceText.includes('## Important spans from the complete trace'),
    'LM trace detail includes complete-trace highlights');
  check(traceText.includes('late failure') && traceText.includes('late slow operation')
      && traceText.includes('final operation'),
    'LM trace highlights include important spans after the first page');
  check(traceText.includes('handle_responses') && traceText.includes('execute_tool Read'),
    'LM trace highlights include late high-token and tool spans');

  const tracePageResult = await traceTool.invoke({
    input: { traceId: 'large-trace', fromSpan: 51, spanCount: 25 },
  }, token);
  const tracePageText = tracePageResult.content[0].value;
  check(tracePageText.includes('## Span Detail (51–75 of 300)'),
    'LM trace detail renders an explicitly requested page');
  check((tracePageText.match(/spanId: /g) || []).length === 25,
    'LM trace detail page contains the requested number of spans');

  const targetedTraceResult = await traceTool.invoke({
    input: { traceId: 'large-trace', spanId: 'span-251' },
  }, token);
  const targetedTraceText = targetedTraceResult.content[0].value;
  check(targetedTraceText.includes('position 251 of 300')
      && (targetedTraceText.match(/spanId: /g) || []).length === 1,
    'LM trace detail retrieves one exact late span');

  const missingSpanResult = await traceTool.invoke({
    input: { traceId: 'large-trace', spanId: 'missing-span' },
  }, token);
  check(missingSpanResult.content[0].value.includes('was not found in trace'),
    'LM trace detail reports an unknown exact span');

  const traceRangeResult = await traceTool.invoke({
    input: { traceId: 'large-trace', fromSpan: 301 },
  }, token);
  const traceRangeText = traceRangeResult.content[0].value;
  check(traceRangeText.includes('fromSpan=301 is out of range'),
    'LM trace detail rejects a start past the final span');

  const traceBudgetResult = await traceTool.invoke({
    input: { traceId: 'budget-trace', spanCount: 100 },
  }, token);
  const traceBudgetText = traceBudgetResult.content[0].value;
  const renderedBudgetSpans = (traceBudgetText.match(/spanId: /g) || []).length;
  const nextBudgetSpan = Number(traceBudgetText.match(/fromSpan=(\d+)/)?.[1]);
  check(renderedBudgetSpans > 0 && renderedBudgetSpans < 100,
    'LM trace detail stops an oversized page at its output budget');
  check(traceBudgetText.includes('Output budget reached'),
    'LM trace detail reports when its output budget stops a page');
  check(nextBudgetSpan === renderedBudgetSpans + 1,
    'LM trace detail budget continuation starts after the last rendered span');
  check(traceBudgetText.length < 42_000,
    'LM trace detail budget includes room for its continuation message');

  const listResult = await tool.invoke({ input: {} }, token);
  const listText = listResult.content[0].value;
  check(listText.includes('| Traces |'), 'LM session list labels its trace count accurately');
  check(!listText.includes('| Turns |'), 'LM session list does not present traces as model turns');

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

  const outOfRangeResult = await tool.invoke({
    input: { sessionId: 'tool-session', fromTurn: 3 },
  }, token);
  const outOfRangeText = outOfRangeResult.content[0].value;
  check(outOfRangeText.includes('fromTurn=3 is out of range'),
    'LM transcript rejects a start past the final turn instead of repeating it');
  check(!outOfRangeText.includes('## Turn 2'),
    'LM transcript does not silently clamp an out-of-range start to the last turn');

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

module.exports = { languageModelToolChecks };
