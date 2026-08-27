'use strict';

// Framework-free runner: awaits each suite in the original order, then prints a
// single N/N summary and exits 0/1. Pass suite names as args to run a subset.
const { state } = require('./lib/assert');

const { e2ePipelineChecks } = require('./suites/e2e-pipeline');
const { retentionChecks } = require('./suites/retention');
const { materializationChecks } = require('./suites/materialization');
const { sessionTitleChecks } = require('./suites/session-titles');
const { transcriptPromptChecks } = require('./suites/transcript-prompts');
const { sessionTranscriptToolChecks } = require('./suites/session-transcript-tool');
const { sessionAgentKindChecks } = require('./suites/session-agent-kind');
const { agentHostAnchorChecks } = require('./suites/agent-host-anchors');
const { backgroundTraceChecks } = require('./suites/background-traces');
const { claudeLogTranscriptChecks } = require('./suites/claude-log-transcript');
const { codexLogShapeChecks } = require('./suites/codex-log-shape');
const { codexSessionTranscriptChecks } = require('./suites/codex-session');
const { dailyTokenUsageChecks } = require('./suites/token-usage');
const { harnessTokenAccountingChecks } = require('./suites/token-accounting');
const { sessionTokenAccountingChecks } = require('./suites/session-token-accounting');
const { harnessCountingChecks } = require('./suites/harness-counting');
const { claudeCountingChecks } = require('./suites/claude-counting');

// Run the end-to-end pipeline before focused regression suites.
const SUITES = [
  ['e2e-pipeline', e2ePipelineChecks],
  ['retention', retentionChecks],
  ['materialization', materializationChecks],
  ['session-titles', sessionTitleChecks],
  ['transcript-prompts', transcriptPromptChecks],
  ['session-transcript-tool', sessionTranscriptToolChecks],
  ['session-agent-kind', sessionAgentKindChecks],
  ['agent-host-anchors', agentHostAnchorChecks],
  ['background-traces', backgroundTraceChecks],
  ['claude-log-transcript', claudeLogTranscriptChecks],
  ['codex-log-shape', codexLogShapeChecks],
  ['codex-session', codexSessionTranscriptChecks],
  ['token-usage', dailyTokenUsageChecks],
  ['token-accounting', harnessTokenAccountingChecks],
  ['session-token-accounting', sessionTokenAccountingChecks],
  ['harness-counting', harnessCountingChecks],
  ['claude-counting', claudeCountingChecks],
];

(async () => {
  const only = process.argv.slice(2);
  if (only.length) {
    const known = new Set(SUITES.map(([n]) => n));
    const unknown = only.filter((n) => !known.has(n));
    if (unknown.length) {
      console.error(`Unknown suite(s): ${unknown.join(', ')}\nAvailable: ${[...known].join(', ')}`);
      process.exit(1);
    }
  }
  const selected = only.length ? SUITES.filter(([n]) => only.includes(n)) : SUITES;

  for (const [, run] of selected) {
    await run();
  }

  const total = state.pass + state.failures.length;
  if (state.failures.length) {
    console.error(`\nSMOKE TEST FAILED: ${state.failures.length}/${total} assertions failed`);
    process.exit(1);
  }
  console.log(`\nSMOKE TEST PASSED: ${state.pass}/${total} assertions`);
  process.exit(0);
})().catch((err) => {
  console.error('SMOKE TEST ERROR:', err);
  process.exit(1);
});
