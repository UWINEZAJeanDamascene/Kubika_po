/**
 * Tax model — PostgreSQL (Prisma) backed.
 * Preserves legacy static calculation helpers from the Mongoose model.
 */

const { buildTenantModel } = require('../utils/masterDataCommon');
const {
  taxToApi,
  taxTranslateCreate,
  taxTranslateUpdate,
} = require('../utils/masterDataMappers');

const FIELD_MAP = {
  taxType: { target: 'taxType' },
  vatRate: { target: 'vatRate' },
  vatOutput: { target: 'vatOutput' },
  vatInput: { target: 'vatInput' },
  vatNet: { target: 'vatNet' },
  vatPeriod: { target: 'vatPeriod' },
  corporateIncomeRate: { target: 'corporateIncomeRate' },
  taxableIncome: { target: 'taxableIncome' },
  taxOwed: { target: 'taxOwed' },
  payeCollected: { target: 'payeCollected' },
  payePaid: { target: 'payePaid' },
  payePeriod: { target: 'payePeriod' },
  withholdingCollected: { target: 'withholdingCollected' },
  withholdingPaid: { target: 'withholdingPaid' },
  tradingLicenseFee: { target: 'tradingLicenseFee' },
  tradingLicenseYear: { target: 'tradingLicenseYear' },
  tradingLicenseStatus: { target: 'tradingLicenseStatus' },
  payments: { target: 'payments' },
  filings: { target: 'filings' },
  calendar: { target: 'calendar' },
  status: { target: 'status' },
  notes: { target: 'notes' },
};

const Tax = buildTenantModel({
  name: 'Tax',
  collection: 'taxes',
  delegateName: 'tax',
  fieldMap: FIELD_MAP,
  toApi: taxToApi,
  translateCreate: taxTranslateCreate,
  translateUpdate: taxTranslateUpdate,
});

Tax.calculateVAT = function calculateVAT(vatOutput, vatInput) {
  const netVAT = vatOutput - vatInput;
  return {
    vatOutput,
    vatInput,
    vatNet: netVAT,
    isPayable: netVAT > 0,
    refund: netVAT < 0 ? Math.abs(netVAT) : 0,
  };
};

Tax.calculateCorporateTax = function calculateCorporateTax(taxableIncome, rate = 30) {
  const taxOwed = taxableIncome * (rate / 100);
  return {
    taxableIncome,
    rate,
    taxOwed: Math.round(taxOwed * 100) / 100,
  };
};

Tax.calculatePAYE = function calculatePAYE(grossSalaries) {
  const Payroll = require('./Payroll');
  return Payroll.calculatePAYE(grossSalaries);
};

Tax.getDefaultDueDates = function getDefaultDueDates(taxType) {
  const defaults = {
    vat: { day: 15, recurrence: 'monthly' },
    corporate_income: { day: 31, recurrence: 'quarterly' },
    paye: { day: 15, recurrence: 'monthly' },
    withholding: { day: 15, recurrence: 'monthly' },
    trading_license: { day: 31, recurrence: 'annually' },
  };
  return defaults[taxType] || defaults.vat;
};

Tax.generateCalendarEntries = function generateCalendarEntries(companyId, year) {
  const entries = [];
  const taxTypes = ['vat', 'paye'];

  taxTypes.forEach((taxType) => {
    for (let month = 1; month <= 12; month += 1) {
      const dueDate = new Date(year, month - 1, 15);
      entries.push({
        company: companyId,
        taxType,
        dueDate,
        period: { month, year },
        isRecurring: true,
        recurrencePattern: 'monthly',
        status: dueDate < new Date() ? 'overdue' : 'upcoming',
      });
    }
  });

  entries.push({
    company: companyId,
    taxType: 'trading_license',
    dueDate: new Date(year, 0, 31),
    period: { month: 1, year },
    isRecurring: true,
    recurrencePattern: 'annually',
    status: new Date() > new Date(year, 0, 31) ? 'overdue' : 'upcoming',
  });

  return entries;
};

module.exports = Tax;
