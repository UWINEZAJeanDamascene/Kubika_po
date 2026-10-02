/**
 * Rwanda payroll statutory rules. Rates are effective dated so backdated
 * payroll uses the rule that applied to its tax period.
 * Monetary payroll outputs retain cents except PAYE, which RRA rounds up to
 * the next whole RWF.
 */

const PAYE_RULES = [
  {
    effectiveFrom: "2023-11-01",
    bands: [
      { upTo: 60000, rate: 0 },
      { upTo: 100000, rate: 0.1 },
      { upTo: 200000, rate: 0.2 },
      { upTo: Infinity, rate: 0.3 },
    ],
  },
];

const RSSB_RULES = [
  { effectiveFrom: "1900-01-01", effectiveTo: "2024-12-31", pensionEmployeeRate: 0.03, pensionEmployerRate: 0.03, maternityEmployeeRate: 0.003, maternityEmployerRate: 0.003, occupationalHazardEmployerRate: 0.02 },
  { effectiveFrom: "2025-01-01", effectiveTo: "2026-12-31", pensionEmployeeRate: 0.06, pensionEmployerRate: 0.06, maternityEmployeeRate: 0.003, maternityEmployerRate: 0.003, occupationalHazardEmployerRate: 0.02 },
  { effectiveFrom: "2027-01-01", effectiveTo: "2027-12-31", pensionEmployeeRate: 0.07, pensionEmployerRate: 0.07, maternityEmployeeRate: 0.003, maternityEmployerRate: 0.003, occupationalHazardEmployerRate: 0.02 },
  { effectiveFrom: "2028-01-01", effectiveTo: "2028-12-31", pensionEmployeeRate: 0.08, pensionEmployerRate: 0.08, maternityEmployeeRate: 0.003, maternityEmployerRate: 0.003, occupationalHazardEmployerRate: 0.02 },
  { effectiveFrom: "2029-01-01", effectiveTo: "2029-12-31", pensionEmployeeRate: 0.09, pensionEmployerRate: 0.09, maternityEmployeeRate: 0.003, maternityEmployerRate: 0.003, occupationalHazardEmployerRate: 0.02 },
  { effectiveFrom: "2030-01-01", pensionEmployeeRate: 0.10, pensionEmployerRate: 0.10, maternityEmployeeRate: 0.003, maternityEmployerRate: 0.003, occupationalHazardEmployerRate: 0.02 },
];

const roundMoney = (value) => Math.round((Number(value) + Number.EPSILON) * 100) / 100;
const amount = (value, field) => {
  const number = Number(value ?? 0);
  if (!Number.isFinite(number) || number < 0) throw new TypeError(`${field} must be a non-negative amount`);
  return number;
};

function effectiveRule(rules, date, name) {
  const asOf = new Date(date);
  if (!Number.isFinite(asOf.getTime())) throw new TypeError("A valid payroll period date is required");
  const day = asOf.toISOString().slice(0, 10);
  const rule = [...rules].reverse().find((item) => item.effectiveFrom <= day && (!item.effectiveTo || item.effectiveTo >= day));
  if (!rule) throw new RangeError(`No ${name} rules are configured for ${day}`);
  return rule;
}

function progressiveTax(taxableIncome, bands) {
  let tax = 0;
  let lower = 0;
  for (const band of bands) {
    const slice = Math.max(0, Math.min(taxableIncome, band.upTo) - lower);
    tax += slice * band.rate;
    lower = band.upTo;
    if (taxableIncome <= band.upTo) break;
  }
  return Math.ceil(tax);
}

function taxBandBreakdown(taxableIncome, bands) {
  let lower = 0;
  return bands.map((band) => {
    const bandBase = roundMoney(Math.max(0, Math.min(taxableIncome, band.upTo) - lower));
    const line = { from: lower, to: Number.isFinite(band.upTo) ? band.upTo : null, rate: band.rate, taxableAmount: bandBase, tax: roundMoney(bandBase * band.rate) };
    lower = band.upTo;
    return line;
  }).filter((line) => line.taxableAmount > 0);
}

function calculateRwandaPayroll({ salary = {}, additionalIncome = {}, deductions = {}, employee = {}, periodDate }) {
  const asOf = periodDate || new Date();
  const payeRule = effectiveRule(PAYE_RULES, asOf, "PAYE");
  const rssbRule = effectiveRule(RSSB_RULES, asOf, "RSSB");

  const earnings = {
    basicSalary: amount(salary.basicSalary, "Basic salary"),
    transportAllowance: amount(salary.transportAllowance, "Transport allowance"),
    housingAllowance: amount(salary.housingAllowance, "Housing allowance"),
    otherAllowances: amount(salary.otherAllowances, "Other allowances"),
    overtime: amount(additionalIncome.overtime ?? salary.overtime, "Overtime"),
    bonuses: amount(additionalIncome.bonuses ?? salary.bonuses, "Bonuses"),
    commissions: amount(additionalIncome.commissions ?? salary.commissions, "Commissions"),
    benefitsInKind: amount(additionalIncome.benefitsInKind ?? salary.benefitsInKind, "Benefits in kind"),
  };
  const cashGrossSalary = roundMoney(
    earnings.basicSalary + earnings.transportAllowance + earnings.housingAllowance + earnings.otherAllowances + earnings.overtime + earnings.bonuses + earnings.commissions,
  );
  const vehicleBenefit = additionalIncome.vehicleProvided ? roundMoney(cashGrossSalary * 0.1) : 0;
  const accommodationBenefit = additionalIncome.accommodationProvided ? roundMoney(cashGrossSalary * 0.2) : 0;
  const totalBenefitsInKind = roundMoney(earnings.benefitsInKind + vehicleBenefit + accommodationBenefit);
  const taxableEmploymentIncome = roundMoney(cashGrossSalary + totalBenefitsInKind);
  // RRA treats ordinary allowances and employment benefits as taxable. Verified
  // business expense reimbursements are excluded and belong in a separate AP flow.
  const taxableBase = taxableEmploymentIncome;
  const pensionBase = taxableEmploymentIncome;
  const maternityBase = taxableEmploymentIncome;
  const occupationalHazardBase = taxableEmploymentIncome;
  const isPrimaryEmployer = employee.isPrimaryEmployer !== false;
  const isCasualWorker = employee.employmentType === "casual" || employee.employmentType === "casual-worker";
  const payeTreatment = !isPrimaryEmployer ? "non_primary_employer" : isCasualWorker ? "casual_worker" : "progressive";
  const paye = payeTreatment === "non_primary_employer"
    ? Math.ceil(taxableBase * 0.3)
    : payeTreatment === "casual_worker"
      ? Math.ceil(taxableBase * 0.15)
      : progressiveTax(taxableBase, payeRule.bands);
  const payeBreakdown = payeTreatment === "progressive"
    ? taxBandBreakdown(taxableBase, payeRule.bands)
    : [{ from: 0, to: null, rate: payeTreatment === "casual_worker" ? 0.15 : 0.3, taxableAmount: taxableBase, tax: roundMoney(taxableBase * (payeTreatment === "casual_worker" ? 0.15 : 0.3)) }];

  const rssbEmployeePension = roundMoney(pensionBase * rssbRule.pensionEmployeeRate);
  const rssbEmployeeMaternity = roundMoney(maternityBase * rssbRule.maternityEmployeeRate);
  const rssbEmployerPension = roundMoney(pensionBase * rssbRule.pensionEmployerRate);
  const rssbEmployerMaternity = roundMoney(maternityBase * rssbRule.maternityEmployerRate);
  const occupationalHazard = roundMoney(occupationalHazardBase * rssbRule.occupationalHazardEmployerRate);

  const otherDeductions = {
    healthInsurance: amount(deductions.healthInsurance, "Health insurance deduction"),
    loanDeductions: amount(deductions.loanDeductions, "Loan deduction"),
    otherDeductions: amount(deductions.otherDeductions, "Other deductions"),
  };
  const totalOtherDeductions = roundMoney(Object.values(otherDeductions).reduce((sum, value) => sum + value, 0));
  const totalStatutoryDeductions = roundMoney(paye + rssbEmployeePension + rssbEmployeeMaternity);
  const totalDeductions = roundMoney(totalStatutoryDeductions + totalOtherDeductions);
  const netPay = roundMoney(cashGrossSalary - totalDeductions);
  if (netPay < 0) throw new RangeError("Payroll deductions exceed cash earnings");

  return {
    ruleVersion: `RW-${new Date(asOf).toISOString().slice(0, 10)}`,
    ruleEffectiveDate: new Date(asOf).toISOString().slice(0, 10),
    earnings,
    grossSalary: cashGrossSalary,
    cashGrossSalary,
    grossRemuneration: taxableEmploymentIncome,
    benefitsInKind: { other: earnings.benefitsInKind, vehicle: vehicleBenefit, accommodation: accommodationBenefit, total: totalBenefitsInKind },
    payeTreatment,
    taxableBase,
    payeBreakdown,
    rssbBases: { pension: pensionBase, maternity: maternityBase, occupationalHazard: occupationalHazardBase },
    deductions: {
      paye,
      rssbEmployeePension,
      rssbEmployeeMaternity,
      totalStatutoryDeductions,
      ...otherDeductions,
      totalOtherDeductions,
      totalDeductions,
    },
    netPay,
    contributions: {
      rssbEmployerPension,
      rssbEmployerMaternity,
      occupationalHazard,
      occupationalHazardRate: rssbRule.occupationalHazardEmployerRate * 100,
      totalEmployerContributions: roundMoney(rssbEmployerPension + rssbEmployerMaternity + occupationalHazard),
      totalEmployerCost: roundMoney(cashGrossSalary + rssbEmployerPension + rssbEmployerMaternity + occupationalHazard),
    },
    employerCost: roundMoney(cashGrossSalary + rssbEmployerPension + rssbEmployerMaternity + occupationalHazard),
    rates: rssbRule,
    rounding: { paye: "ceil_whole_RWF", otherMoney: "nearest_0.01_RWF" },
  };
}

module.exports = { PAYE_RULES, RSSB_RULES, calculateRwandaPayroll };
