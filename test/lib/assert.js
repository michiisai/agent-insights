'use strict';

// Node caches this module, so every suite shares the same `state` object and
// pass/failures accumulate across all of them for the runner's final summary.
const state = { pass: 0, failures: [] };

function check(cond, msg) {
  if (cond) { state.pass++; } else { state.failures.push(msg); console.error('  FAIL:', msg); }
}
function eq(actual, expected, msg) {
  check(actual === expected, `${msg} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
}

module.exports = { state, check, eq };
