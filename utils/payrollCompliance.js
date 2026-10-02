const RWANDA_UTC_OFFSET_HOURS = 2;

function monthlyStatutoryDeadline(periodEnd) {
  const end = new Date(periodEnd);
  if (!Number.isFinite(end.getTime())) return null;
  return new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() + 1, 15)).toISOString().slice(0, 10);
}

function complianceState(dueDate, completed, now = new Date()) {
  if (!dueDate) return "unknown";
  const localNow = new Date(now.getTime() + RWANDA_UTC_OFFSET_HOURS * 60 * 60 * 1000);
  const today = localNow.toISOString().slice(0, 10);
  if (completed) return "complete";
  if (today > dueDate) return "overdue";
  const due = new Date(`${dueDate}T00:00:00.000Z`);
  const localToday = new Date(`${today}T00:00:00.000Z`);
  const days = Math.round((due.getTime() - localToday.getTime()) / 86400000);
  return days <= 5 ? "due_soon" : "upcoming";
}

function buildPayrollDeadlines(run, now = new Date()) {
  const defaultDueDate = monthlyStatutoryDeadline(run.pay_period_end);
  const result = {};
  for (const type of ["paye", "rssb"]) {
    const dueDate = run.compliance?.deadlines?.[type] || defaultDueDate;
    const filing = run.compliance?.filings?.[type];
    const payment = run.remittance?.[type];
    result[type] = {
      due_date: dueDate,
      filing_status: filing?.status === "submitted" ? "complete" : complianceState(dueDate, false, now),
      payment_status: payment?.remitted ? "complete" : complianceState(dueDate, false, now),
      filed_at: filing?.submitted_at || null,
      paid_at: payment?.remitted_date || null,
      filing_reference: filing?.declaration_reference || null,
      payment_reference: payment?.reference_no || null,
    };
  }
  const bankDueDate = run.payment_date ? new Date(run.payment_date).toISOString().slice(0, 10) : null;
  result.salary_payment = {
    due_date: bankDueDate,
    payment_status: run.bank_transfer?.status === "confirmed" ? "complete" : complianceState(bankDueDate, false, now),
    confirmed_at: run.bank_transfer?.confirmed_at || null,
    reference: run.bank_transfer?.transfer_reference || null,
  };
  return result;
}

module.exports = { monthlyStatutoryDeadline, complianceState, buildPayrollDeadlines };
