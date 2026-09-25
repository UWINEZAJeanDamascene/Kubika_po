'use strict';

const { prisma } = require('../lib/prisma');

async function getComplianceCalendar(companyId) {
  const records = await prisma.tax.findMany({
    where: { companyId: String(companyId), status: 'active' },
    select: { id: true, taxType: true, calendar: true },
  });
  return records.flatMap((record) => {
    const entries = Array.isArray(record.calendar)
      ? record.calendar
      : (Array.isArray(record.calendar?.entries) ? record.calendar.entries : []);
    return entries.map((entry) => ({
      id: String(entry.id || `${record.id}:${entry.taxType || record.taxType}:${entry.dueDate || entry.due_date || ''}`),
      taxType: String(entry.taxType || record.taxType),
      dueDate: entry.dueDate || entry.due_date || null,
      status: String(entry.status || 'scheduled'),
      period: entry.period || null,
    }));
  }).filter((entry) => entry.dueDate);
}

module.exports = { getComplianceCalendar };
