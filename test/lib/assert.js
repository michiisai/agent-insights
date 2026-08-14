'use strict';

// Shared assertion tally. Every suite imports the SAME `state` object (Node
// caches this module), so pass/failures accumulate across all of them; the
// runner reads state.pass / state.failures for the final summary.
const state = { pass: 0, failures: [] };

function check(cond, msg) {
  if (cond) { state.pass++; } else { state.failures.push(msg); console.error('  FAIL:', msg); }
}
function eq(actual, expected, msg) {
  check(actual === expected, `${msg} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
}

module.exports = { state, check, eq };
