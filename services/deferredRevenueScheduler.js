const cron = require('node-cron');
const DeferredRevenueService = require('./deferredRevenueService');

let task = null;
let running = false;

async function runDueRecognitions() {
  if (running) return;
  running = true;
  try {
    const result = await DeferredRevenueService.postDueRecognitions(new Date());
    if (result.posted || result.failed) {
      console.log(`[deferred-revenue] Due recognitions: ${result.posted} posted, ${result.failed} failed.`);
    }
  } catch (error) {
    console.error('[deferred-revenue] Due recognition scan failed:', error.message || error);
  } finally {
    running = false;
  }
}

function startScheduler() {
  if (task) return false;
  task = cron.schedule('* * * * *', runDueRecognitions);
  void runDueRecognitions();
  console.log('[deferred-revenue] Recognition scheduler started (every minute).');
  return true;
}

function stopScheduler() {
  if (!task) return false;
  task.stop();
  task = null;
  return true;
}

module.exports = { startScheduler, stopScheduler, runDueRecognitions };
