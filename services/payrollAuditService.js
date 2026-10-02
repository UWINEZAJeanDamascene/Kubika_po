const { dbClient } = require("../lib/prisma");
const { generateObjectId } = require("../utils/objectId");

function payrollSnapshot(record) {
  if (!record) return null;
  return {
    employee_id: record.employee_id || null,
    createdBy: record.createdBy || null,
    approvedBy: record.approvedBy || null,
    period: record.period || null,
    record_status: record.record_status || null,
    payroll_run_id: record.payroll_run_id || null,
    salary: record.salary || null,
    deductions: record.deductions || null,
    contributions: record.contributions || null,
    netPay: record.netPay ?? null,
    payment: record.payment ? {
      status: record.payment.status || null,
      paymentDate: record.payment.paymentDate || null,
      paymentMethod: record.payment.paymentMethod || null,
      reference: record.payment.reference || null,
      journalEntryId: record.payment.journalEntryId || null,
    } : null,
  };
}

function runSnapshot(run) {
  if (!run) return null;
  return {
    reference_no: run.reference_no || null,
    status: run.status || null,
    pay_period_start: run.pay_period_start || null,
    pay_period_end: run.pay_period_end || null,
    total_gross: run.total_gross ?? null,
    total_tax: run.total_tax ?? null,
    total_net: run.total_net ?? null,
    employee_count: run.employee_count ?? null,
    payroll_ids: Array.isArray(run.lines) ? run.lines.map((line) => String(line.payroll_id || "")).filter(Boolean) : [],
    created_by: run.created_by || null,
    posted_by: run.posted_by || null,
    journal_entry_id: run.journal_entry_id || null,
    reversal_journal_entry_id: run.reversal_journal_entry_id || null,
    remittance: run.remittance || null,
    bank_transfer: run.bank_transfer || null,
    compliance: run.compliance || null,
  };
}

async function recordPayrollAudit({ companyId, userId, action, entityType, entityId, before, after, req }) {
  const changes = JSON.parse(JSON.stringify({ before, after }));
  return dbClient().payrollAuditEvent.create({
    data: {
      id: generateObjectId(),
      companyId: String(companyId),
      actorUserId: userId ? String(userId) : null,
      action,
      entityType,
      entityId: String(entityId),
      changes,
      ipAddress: req?.ip || req?.headers?.["x-forwarded-for"]?.split(",")[0]?.trim() || null,
      userAgent: req?.headers?.["user-agent"] || null,
    },
  });
}

module.exports = { recordPayrollAudit, payrollSnapshot, runSnapshot };
