'use strict';

const DecisionEngine = require('./DecisionEngine');
const { createFinding, FINDING_STATUSES } = require('./findingFactory');
const { scoreConfidence } = require('./confidence');

module.exports = {
  ...DecisionEngine,
  createFinding,
  FINDING_STATUSES,
  scoreConfidence,
};
