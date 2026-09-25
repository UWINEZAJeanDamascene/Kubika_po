const Company = require('../models/Company');
const ReportSnapshot = require('../models/ReportSnapshot');
const {
  generateAllReports,
  getCurrentPeriodInfo,
  getPeriodDates
} = require('./reportGeneratorService');

// Schedule patterns
const SCHEDULES = {
  // Weekly - Sunday night at 11:59 PM
  weekly: '59 23 * * 0',
  // Monthly - Last day of month at 11:59 PM
  monthly: '59 23 28-31 * *',
  // Quarterly - End of quarter (March, June, September, December)
  quarterly: '59 23 31 3,6,9,12 *',
  // Semi-annual - June 30 and December 31
  'semi-annual': '59 23 30 6,12 *',
  // Annual - December 31 at 11:59 PM
  annual: '59 23 31 12 *'
};

// Parse cron expression to get next run time (simplified)
const getNextRunTime = (cronExpression) => {
  // This is a simplified version - in production, use a proper cron library
  const now = new Date();
  return now; // For demo purposes, return current time
};

// Get all companies
const getAllCompanies = async () => {
  return Company.find({ isActive: true }).select('_id name');
};

// Generate weekly snapshot
const generateWeeklySnapshot = async (companyId) => {
  try {
    const { year, periodNumber } = getCurrentPeriodInfo('weekly');
    // Generate for last completed week
    const weekNumber = periodNumber > 1 ? periodNumber - 1 : 52;
    const targetYear = periodNumber > 1 ? year : year - 1;

    console.log(`Generating weekly snapshot for company ${companyId}, Week ${weekNumber}, Year ${targetYear}`);
    await generateAllReports(companyId, 'weekly', targetYear, weekNumber);
    console.log(`Weekly snapshot generated successfully`);
  } catch (error) {
    console.error(`Error generating weekly snapshot:`, error);
  }
};

// Generate monthly snapshot
const generateMonthlySnapshot = async (companyId) => {
  try {
    const now = new Date();
    const currentMonth = now.getMonth() + 1;
    const year = now.getFullYear();
    // Generate for last completed month
    const targetMonth = currentMonth > 1 ? currentMonth - 1 : 12;
    const targetYear = currentMonth > 1 ? year : year - 1;

    console.log(`Generating monthly snapshot for company ${companyId}, Month ${targetMonth}, Year ${targetYear}`);
    await generateAllReports(companyId, 'monthly', targetYear, targetMonth);
    console.log(`Monthly snapshot generated successfully`);
  } catch (error) {
    console.error(`Error generating monthly snapshot:`, error);
  }
};

// Generate quarterly snapshot
const generateQuarterlySnapshot = async (companyId) => {
  try {
    const now = new Date();
    const currentQuarter = Math.floor(now.getMonth() / 3) + 1;
    const year = now.getFullYear();
    // Generate for last completed quarter
    const targetQuarter = currentQuarter > 1 ? currentQuarter - 1 : 4;
    const targetYear = currentQuarter > 1 ? year : year - 1;

    console.log(`Generating quarterly snapshot for company ${companyId}, Q${targetQuarter}, Year ${targetYear}`);
    await generateAllReports(companyId, 'quarterly', targetYear, targetQuarter);
    console.log(`Quarterly snapshot generated successfully`);
  } catch (error) {
    console.error(`Error generating quarterly snapshot:`, error);
  }
};

// Generate semi-annual snapshot
const generateSemiAnnualSnapshot = async (companyId) => {
  try {
    const now = new Date();
    const currentHalf = now.getMonth() < 6 ? 1 : 2;
    const year = now.getFullYear();
    // Generate for last completed half
    const targetHalf = currentHalf > 1 ? currentHalf - 1 : 2;
    const targetYear = currentHalf > 1 ? year : year - 1;

    console.log(`Generating semi-annual snapshot for company ${companyId}, H${targetHalf}, Year ${targetYear}`);
    await generateAllReports(companyId, 'semi-annual', targetYear, targetHalf);
    console.log(`Semi-annual snapshot generated successfully`);
  } catch (error) {
    console.error(`Error generating semi-annual snapshot:`, error);
  }
};

// Generate annual snapshot
const generateAnnualSnapshot = async (companyId) => {
  try {
    const lastYear = new Date().getFullYear() - 1;
    console.log(`Generating annual snapshot for company ${companyId}, Year ${lastYear}`);
    await generateAllReports(companyId, 'annual', lastYear, 1);
    console.log(`Annual snapshot generated successfully`);
  } catch (error) {
    console.error(`Error generating annual snapshot:`, error);
  }
};

// Clean old snapshots
const cleanOldSnapshots = async (companyId) => {
  try {
    console.log(`Cleaning old snapshots for company ${companyId}`);
    await ReportSnapshot.cleanOldSnapshots(companyId);
    console.log(`Old snapshots cleaned successfully`);
  } catch (error) {
    console.error(`Error cleaning old snapshots:`, error);
  }
};

// Run all scheduled tasks
const runScheduledTasks = async () => {
  console.log('Running scheduled report generation tasks...');
  const companies = await getAllCompanies();

  for (const company of companies) {
    try {
      // Run all snapshot generations
      await Promise.all([
        generateWeeklySnapshot(company._id),
        generateMonthlySnapshot(company._id),
        generateQuarterlySnapshot(company._id),
        generateSemiAnnualSnapshot(company._id),
        generateAnnualSnapshot(company._id),
        cleanOldSnapshots(company._id)
      ]);
    } catch (error) {
      console.error(`Error processing company ${company._id}:`, error);
    }
  }

  console.log('Scheduled tasks completed');
};

// Generate snapshot for specific period type (manual trigger)
const generateSnapshotForPeriod = async (companyId, periodType) => {
  const { year, periodNumber } = getCurrentPeriodInfo(periodType);

  // For current period, we still want to save a snapshot for comparison
  const targetPeriodNumber = periodNumber > 1 ? periodNumber - 1 : (periodType === 'annual' ? 1 : periodNumber);
  const targetYear = periodNumber > 1 ? year : (periodType === 'annual' ? year - 1 : year);

  return generateAllReports(companyId, periodType, targetYear, targetPeriodNumber);
};

// ── Timer management (prevent leaks on hot reload / restart) ──
let schedulerTimers = [];
let schedulerStarted = false;

function registerSchedulerTimer(timer) {
  schedulerTimers.push(timer);
  return timer;
}

function clearSchedulerTimers() {
  for (const t of schedulerTimers) {
    if (typeof t === 'number') {
      clearTimeout(t);
      clearInterval(t);
    }
  }
  schedulerTimers = [];
}

// Initialize scheduler (sets up cron jobs)
const initializeScheduler = (app) => {
  if (schedulerStarted) {
    console.log('Report scheduler already initialized, skipping duplicate');
    return;
  }
  schedulerStarted = true;
  console.log('Initializing report scheduler...');

  // Full history snapshot generation is intentionally not automatic on every
  // worker boot. It can issue six report jobs per tenant and overload a cold
  // or pooled database. Enable a sequential startup catch-up explicitly when
  // needed; recurring period checks below remain scheduled normally.
  if (String(process.env.REPORT_SNAPSHOT_RUN_ON_STARTUP || '').toLowerCase() === 'true') {
    registerSchedulerTimer(setTimeout(async () => {
      console.log('Running opt-in initial snapshot generation...');
      await runScheduledTasks();
    }, 30000));
  }

  // Set up periodic runs
  // Daily check at midnight
  registerSchedulerTimer(setInterval(async () => {
    const now = new Date();
    const dayOfWeek = now.getDay();
    const date = now.getDate();
    const month = now.getMonth();

    // Weekly - Sunday
    if (dayOfWeek === 0 && now.getHours() === 23 && now.getMinutes() === 59) {
      console.log('Running weekly snapshot generation...');
      const companies = await getAllCompanies();
      for (const company of companies) {
        await generateWeeklySnapshot(company._id);
      }
    }

    // Monthly - Last day of month
    const lastDay = new Date(now.getFullYear(), month + 1, 0).getDate();
    if (date === lastDay && now.getHours() === 23 && now.getMinutes() === 59) {
      console.log('Running monthly snapshot generation...');
      const companies = await getAllCompanies();
      for (const company of companies) {
        await generateMonthlySnapshot(company._id);
      }
    }

    // Quarterly - End of March, June, September, December
    if ([3, 6, 9, 12].includes(month + 1) && date === lastDay && now.getHours() === 23 && now.getMinutes() === 59) {
      console.log('Running quarterly snapshot generation...');
      const companies = await getAllCompanies();
      for (const company of companies) {
        await generateQuarterlySnapshot(company._id);
      }
    }

    // Semi-annual - June 30 and December 31
    if ((month === 5 || month === 11) && date === 30 && now.getHours() === 23 && now.getMinutes() === 59) {
      console.log('Running semi-annual snapshot generation...');
      const companies = await getAllCompanies();
      for (const company of companies) {
        await generateSemiAnnualSnapshot(company._id);
      }
    }

    // Annual - December 31
    if (month === 11 && date === 31 && now.getHours() === 23 && now.getMinutes() === 59) {
      console.log('Running annual snapshot generation...');
      const companies = await getAllCompanies();
      for (const company of companies) {
        await generateAnnualSnapshot(company._id);
      }
    }

    // Clean old snapshots daily at 2 AM
    if (now.getHours() === 2 && now.getMinutes() === 0) {
      console.log('Running daily snapshot cleanup...');
      const companies = await getAllCompanies();
      for (const company of companies) {
        await cleanOldSnapshots(company._id);
      }
    }
  }, 60000)); // Check every minute

  console.log('Report scheduler initialized');
};

function stopScheduler() {
  clearSchedulerTimers();
  schedulerStarted = false;
}

// Get available periods for a company
const getAvailablePeriods = async (companyId, periodType, limit = 24) => {
  return ReportSnapshot.getAvailablePeriods(companyId, periodType, limit);
};

// Manual snapshot generation endpoint
const manuallyGenerateSnapshot = async (companyId, periodType, year, periodNumber) => {
  return generateAllReports(companyId, periodType, year, periodNumber);
};

module.exports = {
  initializeScheduler,
  stopScheduler,
  runScheduledTasks,
  generateWeeklySnapshot,
  generateMonthlySnapshot,
  generateQuarterlySnapshot,
  generateSemiAnnualSnapshot,
  generateAnnualSnapshot,
  cleanOldSnapshots,
  generateSnapshotForPeriod,
  getAvailablePeriods,
  manuallyGenerateSnapshot
};
