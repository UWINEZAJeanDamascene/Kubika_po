#!/usr/bin/env node
/**
 * CLI wrapper for Phase 0 readiness — used in deploy scripts and CI.
 */
require('dotenv').config();
require('../lib/sentry').initSentry();

const { assertPerformanceReadinessAtBoot, getPerformanceReadiness } = require('../utils/performancePhase0');

(async () => {
  const checkOnly = process.argv.includes('--check');
  if (checkOnly) {
    const readiness = await getPerformanceReadiness();
    console.log(JSON.stringify(readiness, null, 2));
    process.exit(readiness.ready ? 0 : 1);
  }

  try {
    const readiness = await assertPerformanceReadinessAtBoot();
    console.log(JSON.stringify(readiness, null, 2));
    process.exit(readiness.ready || readiness.skipped ? 0 : 1);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
})();
