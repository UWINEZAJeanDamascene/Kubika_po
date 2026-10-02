// Canonical ledger accounts used by payroll accruals, payments, and remittances.
// Keep these aligned with DEFAULT_CHART_OF_ACCOUNTS in chartOfAccounts.js.
const PAYROLL_ACCOUNTS = Object.freeze({
  directLaborExpense: "5300",
  salaryExpense: "5400",
  employerContributionExpense: "6150",
  payePayable: "2230",
  salaryPayable: "2300",
  employeePensionPayable: "2320",
  employeeMaternityPayable: "2321",
  employerPensionPayable: "2330",
  employerMaternityPayable: "2331",
  occupationalHazardPayable: "2332",
  otherDeductionsPayable: "2600",
  defaultBank: "1100",
});

function assertJournalBalanced(lines, label = "Payroll journal") {
  const total = (side) => (lines || []).reduce((sum, line) => sum + Number(line[side] || 0), 0);
  const debits = Math.round(total("debit") * 100) / 100;
  const credits = Math.round(total("credit") * 100) / 100;
  if (!lines?.length || Math.abs(debits - credits) > 0.01) {
    const error = new Error(`${label} is out of balance (debits ${debits.toFixed(2)}, credits ${credits.toFixed(2)})`);
    error.code = "PAYROLL_JOURNAL_UNBALANCED";
    error.statusCode = 409;
    throw error;
  }
  return { debits, credits };
}

module.exports = { PAYROLL_ACCOUNTS, assertJournalBalanced };
