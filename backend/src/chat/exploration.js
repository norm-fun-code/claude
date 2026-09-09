'use strict';

// The editable Studio handoff identifies hypothetical decision turns. Keeping
// this at the reasoning boundary also covers retries and older mobile clients.
const EXPLORATION_PREFIX = 'Decision Studio — explore only';
function isExploration(question) {
  return typeof question === 'string' && question.trimStart().startsWith(EXPLORATION_PREFIX + '\n');
}
const EXPLORATION_SYSTEM = '\n\nDECISION EXPLORATION: The options in this turn are hypothetical, not reports of events or instructions to act. Compare them using available evidence and explicitly separate assumptions. Do not claim to have changed anything, emit action or recommendation tags, create commitments, or treat an option as a new fact about the user. Give advice and a reversible next step only.';
module.exports = { isExploration, EXPLORATION_PREFIX, EXPLORATION_SYSTEM };
