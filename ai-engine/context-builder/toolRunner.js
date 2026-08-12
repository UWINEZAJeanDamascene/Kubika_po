'use strict';

const { executeTool } = require('../../services/aiToolService');

async function runTool(companyId, toolName, args = {}) {
  const startedAt = Date.now();
  const result = await executeTool(companyId, toolName, args);
  const elapsedMs = Date.now() - startedAt;

  if (result && result.error) {
    const error = new Error(result.error);
    error.toolName = toolName;
    error.elapsedMs = elapsedMs;
    throw error;
  }

  return { result, elapsedMs };
}

module.exports = {
  runTool,
};

