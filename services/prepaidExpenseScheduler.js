const cron = require('node-cron');
const PrepaidExpenseService = require('./prepaidExpenseService');

let task = null;
let running = false;

async function runDueAmortizations() {
  if (running) return;
  running = true;
  try {
    const result = await PrepaidExpenseService.postDueAmortizations(new Date());
    if (result.posted || result.failed) {
      console.log(`[prepaid-expenses] Due amortizations: ${result.posted} posted, ${result.failed} failed.`);
    }
  } catch (error) {
    console.error('[prepaid-expenses] Due amortization scan failed:', error.message || error);
  } finally {
    running = false;
  }
}

function startScheduler() {
  if (task) return false;
  // Check each minute so a due row is posted promptly after its scheduled date.
  // The journal entry itself uses the exact scheduled date, and missed runs are
  // picked up on startup or the next scan.
  task = cron.schedule('* * * * *', runDueAmortizations);
  void runDueAmortizations();
  console.log('[prepaid-expenses] Amortization scheduler started (every minute).');
  return true;
}

function stopScheduler() {
  if (!task) return false;
  task.stop();
  task = null;
  return true;
}

module.exports = { startScheduler, stopScheduler, runDueAmortizations };
