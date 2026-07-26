/**
 * Daily exchange-rate sync scheduler (Prisma-backed, no MongoDB dependency).
 *
 * Pulls market rates from the external API for every company's base currency
 * and stores them in the exchange_rates history table (source: 'api').
 * If the API is unreachable the last known rates are kept and will surface
 * as `stale` in the UI — nothing is overwritten silently.
 *
 * Config:
 *   EXCHANGE_RATE_SYNC_CRON      cron expression (default: '0 6 * * *' — daily 06:00)
 *   EXCHANGE_RATE_SYNC_ON_START  'false' to skip the one-off sync after boot
 */

const cron = require('node-cron');
const CurrencyService = require('./CurrencyService');

let task = null;

async function runSync(trigger) {
  try {
    const summary = await CurrencyService.syncAllCompanies();
    const failedNote = summary.failed.length
      ? ` (${summary.failed.length} failed: ${summary.failed.map((f) => f.error).slice(0, 3).join('; ')})`
      : '';
    console.log(`💱 Exchange rate sync [${trigger}]: ${summary.ok}/${summary.total} companies updated${failedNote}`);
  } catch (err) {
    console.warn(`💱 Exchange rate sync [${trigger}] failed:`, err.message || err);
  }
}

function startExchangeRateScheduler() {
  const expression = process.env.EXCHANGE_RATE_SYNC_CRON || '0 6 * * *';

  if (!cron.validate(expression)) {
    console.warn(`💱 Invalid EXCHANGE_RATE_SYNC_CRON "${expression}" — exchange rate scheduler not started`);
    return;
  }

  task = cron.schedule(expression, () => runSync('scheduled'));
  console.log(`💱 Exchange rate sync scheduled (${expression})`);

  if (process.env.EXCHANGE_RATE_SYNC_ON_START !== 'false') {
    // One-off sync shortly after boot so fresh installs have rates immediately.
    setTimeout(() => runSync('startup'), 20 * 1000);
  }
}

function stopExchangeRateScheduler() {
  if (task) {
    task.stop();
    task = null;
  }
}

module.exports = { startExchangeRateScheduler, stopExchangeRateScheduler, runSync };
