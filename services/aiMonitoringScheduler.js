'use strict';

const cron = require('node-cron');
const { AI_DOMAINS } = require('../ai-engine/shared/interfaces');
const MonitoringService = require('./aiMonitoringService');
const config = require('../src/config/environment').getConfig();
const { isTenantFeatureEnabled } = require('./aiFeatureFlags');

const TIME_ZONE = 'Africa/Kigali';
const tasks = [];
const running = new Set();

function schedule(label, expression, options = {}) {
  const task = cron.schedule(expression, async () => {
    if (running.has(label)) {
      console.warn(`[ai-monitoring] Skipping ${label}; previous run is still active.`);
      return;
    }
    running.add(label);
    try {
      const results = await MonitoringService.runScanForAllCompanies(options);
      console.log(`[ai-monitoring] ${label} completed for ${results.length} companies.`);
    } catch (error) {
      console.error(`[ai-monitoring] ${label} failed:`, error.message || error);
    } finally {
      running.delete(label);
    }
  }, { timezone: TIME_ZONE });
  tasks.push(task);
}

function startMonitoringScheduler() {
  if (tasks.length) return;
  if (config.ai.killSwitches.scheduledMonitoring || !config.ai.featureFlags.proactiveFindings) {
    console.log('[ai-monitoring] Scheduler disabled by AI monitoring kill switch or feature flag.');
    return false;
  }
  schedule('inventory-risk', '0 */2 * * *', { domains: [AI_DOMAINS.INVENTORY] });
  schedule('cash-receivables-payables', '0 7 * * *', {
    domains: [AI_DOMAINS.FINANCE, AI_DOMAINS.CUSTOMERS, AI_DOMAINS.PURCHASES, AI_DOMAINS.SUPPLIERS],
  });
  schedule('sales-trends', '10 7 * * *', { domains: [AI_DOMAINS.SALES] });
  schedule('tax-compliance', '20 7 * * *', { domains: [AI_DOMAINS.TAX] });
  schedule('anomaly-fraud', '30 7 * * *', { domains: [AI_DOMAINS.FINANCE, AI_DOMAINS.PURCHASES] });
  schedule('daily-briefing', '45 7 * * *', { createBriefing: true });
  console.log(`[ai-monitoring] Scheduled tenant scans using ${TIME_ZONE}.`);
  return true;
}

function stopMonitoringScheduler() {
  while (tasks.length) {
    const task = tasks.pop();
    try { task.stop(); } catch (error) { console.warn('[ai-monitoring] Failed to stop cron task:', error.message || error); }
  }
}

module.exports = { startMonitoringScheduler, stopMonitoringScheduler };
