require('dotenv').config();
const mongoose = require('mongoose');
const { connectPrisma } = require('../lib/prisma');
const WeeklyReportsService = require('../services/weeklyReportsService');
const Invoice = require('../models/Invoice');
const Purchase = require('../models/Purchase');

const companyId = '6a1682833035c524d960189e';

(async () => {
  await connectPrisma();

  const ar = await WeeklyReportsService.getWeeklyReceivablesAging(companyId);
  console.log('AR summary:', ar.summary);

  const directInv = await Invoice.find({
    company: companyId,
    status: { $in: ['partially_paid', 'confirmed', 'sent'] },
    amountOutstanding: { $gt: 0 },
  }).lean();
  console.log('Direct invoice find count:', directInv.length);

  const ap = await WeeklyReportsService.getWeeklyPayablesAging(companyId);
  console.log('AP summary:', ap.summary);

  const cf = await WeeklyReportsService.getWeeklyCashFlow(companyId, '2026-07-20');
  console.log('Cash flow summary:', cf.summary);

  const payroll = await WeeklyReportsService.getWeeklyPayrollPreview(companyId);
  console.log('Payroll:', payroll);

  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
