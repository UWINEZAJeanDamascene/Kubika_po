const TaxRate = require("../models/TaxRate");
const { dbClient } = require('../lib/prisma');
const JournalService = require("./journalService");
const TaxAutomationService = require("./taxAutomationService");
const SequenceService = require("./sequenceService");
const PeriodService = require("./periodService");
const { BankAccount } = require("../models/BankAccount");

async function journalAmount(companyId, periodStart, periodEnd, accountCodes, amountField, sourceTypes = null) {
  const where = {
    companyId: String(companyId),
    accountCode: { in: accountCodes },
    [amountField]: { gt: 0 },
    journalEntry: {
      status: 'posted',
      reversed: false,
      date: { gte: new Date(periodStart), lte: new Date(periodEnd) },
      ...(sourceTypes ? { sourceType: { in: sourceTypes } } : {}),
    },
  };
  const result = await dbClient().journalEntryLine.aggregate({ where, _sum: { [amountField]: true } });
  return Number(result._sum[amountField] || 0);
}

class TaxService {
  // ── TAX RATE MANAGEMENT ─────────────────────────────────────────────

  /**
   * Create a new tax rate
   */
  static async createTaxRate(companyId, data) {
    const taxRate = new TaxRate({
      company: companyId,
      name: data.name,
      code: data.code,
      rate_pct: data.rate_pct,
      type: data.type,
      input_account_id: data.input_account_id,
      output_account_id: data.output_account_id,
      input_account_code: data.input_account_code,
      output_account_code: data.output_account_code,
      is_active: data.is_active !== undefined ? data.is_active : true,
      effective_from: data.effective_from,
      effective_to: data.effective_to || null,
    });

    return taxRate.save();
  }

  /**
   * Get all tax rates for a company
   */
  static async getTaxRates(companyId, filters = {}) {
    const query = { company: companyId };

    if (filters.is_active !== undefined) {
      query.is_active = filters.is_active;
    }
    if (filters.type) {
      query.type = filters.type;
    }
    if (filters.code) {
      query.code = filters.code;
    }

    return TaxRate.find(query).sort({ code: 1 });
  }

  /**
   * Get a single tax rate by ID
   */
  static async getTaxRateById(companyId, taxRateId) {
    return TaxRate.findOne({ _id: taxRateId, company: companyId });
  }

  /**
   * Get a single tax rate by code
   */
  static async getTaxRateByCode(companyId, code) {
    return TaxRate.findOne({ company: companyId, code: code.toUpperCase() });
  }

  /**
   * Update a tax rate
   */
  static async updateTaxRate(companyId, taxRateId, data) {
    const updateData = {};

    if (data.name) updateData.name = data.name;
    if (data.rate_pct !== undefined) updateData.rate_pct = data.rate_pct;
    if (data.type) updateData.type = data.type;
    if (data.input_account_id)
      updateData.input_account_id = data.input_account_id;
    if (data.output_account_id)
      updateData.output_account_id = data.output_account_id;
    if (data.input_account_code)
      updateData.input_account_code = data.input_account_code;
    if (data.output_account_code)
      updateData.output_account_code = data.output_account_code;
    if (data.is_active !== undefined) updateData.is_active = data.is_active;
    if (data.effective_from) updateData.effective_from = data.effective_from;
    if (data.effective_to !== undefined)
      updateData.effective_to = data.effective_to;

    return TaxRate.findOneAndUpdate(
      { _id: taxRateId, company: companyId },
      updateData,
      { new: true },
    );
  }

  /**
   * Delete (deactivate) a tax rate
   */
  static async deleteTaxRate(companyId, taxRateId) {
    return TaxRate.findOneAndUpdate(
      { _id: taxRateId, company: companyId },
      { is_active: false },
      { new: true },
    );
  }

  // ── TAX LIABILITY REPORT ─────────────────────────────────────────────
  /**
   * Computed entirely from posted journal lines — no separate tax table.
   * Covers VAT, PAYE, and RSSB sections.
   *
   * Every figure is computed live from journal entry lines filtered by company_id and date range.
   * Accounts queried are explicitly reported so an auditor can verify independently.
   */
  static async getLiabilityReport(
    companyId,
    { periodStart, periodEnd, taxCode },
  ) {
    // ── VAT SECTION ────────────────────────────────────────────────
    const vatOutputCodes = ["2220"];
    const vatInputCodes = ["2210"];

    // Output VAT — sum of credit lines on VAT Output accounts
    const outputVat = await journalAmount(companyId, periodStart, periodEnd, vatOutputCodes, 'credit');

    // Output VAT reversed — sum of debit lines on VAT Output accounts (credit notes)
    const outputVatReversed = await journalAmount(companyId, periodStart, periodEnd, vatOutputCodes, 'debit');

    // Input VAT — sum of debit lines on VAT Input accounts
    const inputVat = await journalAmount(companyId, periodStart, periodEnd, vatInputCodes, 'debit');

    // Input VAT reversed — sum of credit lines on VAT Input accounts (purchase returns)
    const inputVatReversed = await journalAmount(companyId, periodStart, periodEnd, vatInputCodes, 'credit');

    const netOutputVat = outputVat - outputVatReversed;
    const netInputVat = inputVat - inputVatReversed;
    const netVatPayable = netOutputVat - netInputVat;

    // ── PAYE SECTION ───────────────────────────────────────────────
    const payePayableCodes = ["2230"];

    // PAYE withheld — sum of credit lines on PAYE accounts
    const payeWithheld = await journalAmount(companyId, periodStart, periodEnd, payePayableCodes, 'credit');

    // PAYE remitted — sum of debit lines on PAYE accounts (settlements)
    const payeRemitted = await journalAmount(companyId, periodStart, periodEnd, payePayableCodes, 'debit', ["paye_settlement", "payroll_tax"]);
    const payeOutstanding = payeWithheld - payeRemitted;

    // ── RSSB SECTION ───────────────────────────────────────────────
    const rssbPayableCodes = ["2240"];

    // RSSB contributions — sum of credit lines on RSSB accounts
    const rssbContributed = await journalAmount(companyId, periodStart, periodEnd, rssbPayableCodes, 'credit');

    // RSSB remitted — sum of debit lines on RSSB accounts (settlements)
    const rssbRemitted = await journalAmount(companyId, periodStart, periodEnd, rssbPayableCodes, 'debit', ["rssb_settlement", "payroll_tax"]);
    const rssbOutstanding = rssbContributed - rssbRemitted;

    return {
      company_id: companyId,
      period_start: periodStart,
      period_end: periodEnd,
      computed_at: new Date(),

      // VAT Section
      vat: {
        output_vat_collected: outputVat,
        output_vat_reversed: outputVatReversed,
        net_output_vat: netOutputVat,
        input_vat_claimed: inputVat,
        input_vat_reversed: inputVatReversed,
        net_input_vat: netInputVat,
        net_vat_payable: netVatPayable,
        is_payable: netVatPayable > 0,
        refund_due: netVatPayable < 0 ? Math.abs(netVatPayable) : 0,
        accounts_queried: {
          output: vatOutputCodes,
          input: vatInputCodes,
        },
      },

      // PAYE Section
      paye: {
        total_withheld: payeWithheld,
        total_remitted: payeRemitted,
        outstanding: payeOutstanding,
        accounts_queried: payePayableCodes,
      },

      // RSSB Section
      rssb: {
        total_contributions: rssbContributed,
        total_remitted: rssbRemitted,
        outstanding: rssbOutstanding,
        accounts_queried: rssbPayableCodes,
      },

      // Grand totals
      totals: {
        total_tax_liability:
          Math.max(0, netVatPayable) + payeOutstanding + rssbOutstanding,
        total_remitted: payeRemitted + rssbRemitted,
      },
    };
  }

  // ── TAX SETTLEMENT ─────────────────────────────────────────────────
  /**
   * Post tax settlement - pays tax liability to authorities
   * Supports VAT, PAYE, and RSSB settlement types.
   *
   * Uses TaxAutomationService for journal line computation.
   */
  static async postSettlement(companyId, data, userId) {
    // Get bank account
    let bankAccount;
    if (data.bank_account_id) {
      bankAccount = await BankAccount.findOne({
        _id: data.bank_account_id,
        company: companyId,
      });
      if (!bankAccount) {
        throw new Error("BANK_ACCOUNT_NOT_FOUND");
      }
    }

    const refNo = await SequenceService.nextSequence(companyId, "TXST");

    // Determine cash account code
    let cashAccountCode;
    if (bankAccount && bankAccount.ledgerAccountId) {
      cashAccountCode = bankAccount.ledgerAccountId;
    } else if (data.payment_method === "bank" || data.bank_account_id) {
      cashAccountCode = "1100";
    } else {
      cashAccountCode = "1000";
    }

    // Determine settlement type and compute journal lines via TaxAutomationService
    const settlementType = (data.settlement_type || "vat").toLowerCase();
    let settlement;
    let sourceType = "tax_settlement";

    switch (settlementType) {
      case "paye":
        settlement = TaxAutomationService.computePayeSettlement(
          companyId,
          data.amount,
          cashAccountCode,
        );
        sourceType = "paye_settlement";
        break;
      case "rssb":
        settlement = TaxAutomationService.computeRssbSettlement(
          companyId,
          data.amount,
          cashAccountCode,
        );
        sourceType = "rssb_settlement";
        break;
      case "vat":
      default:
        settlement = TaxAutomationService.computeVatSettlement(
          companyId,
          data.amount,
          cashAccountCode,
        );
        sourceType = "vat_settlement";
        break;
    }

    // Validate journal lines are balanced
    TaxAutomationService.assertBalanced(
      settlement.journalLines,
      `${settlementType} settlement`,
    );

    const periodId = await PeriodService.getOpenPeriodId(
      companyId,
      data.settlement_date,
    );
    const narration = `${settlementType.toUpperCase()} Settlement - ${data.period_description || "Tax Period"} - TXST#${refNo}`;

    const journalEntry = await JournalService.createEntry(companyId, userId, {
      date: data.settlement_date,
      description: narration,
      sourceType,
      sourceId: `taxsettlement_${companyId}_${refNo}`,
      sourceReference: `TXST#${refNo}`,
      lines: settlement.journalLines,
      isAutoGenerated: true,
      periodId,
    });

    // Create BankTransaction so the bank account balance decreases immediately.
    // Without this, the journal entry correctly credits the bank GL account but the
    // per-account BankTransaction history and cachedBalance are never updated.
    if (bankAccount && data.amount > 0) {
      try {
        await bankAccount.addTransaction({
          type: "withdrawal",
          amount: data.amount,
          description: narration,
          date: data.settlement_date
            ? new Date(data.settlement_date)
            : new Date(),
          referenceNumber: `TXST#${refNo}`,
          referenceType: "Payment",
          reference: journalEntry._id,
          createdBy: userId,
          notes: `${settlementType.toUpperCase()} tax settlement — TXST#${refNo}`,
          journalEntryId: journalEntry._id,
        });
      } catch (btErr) {
        console.error(
          "BankTransaction creation failed for tax settlement:",
          btErr.message,
        );
        // Non-fatal — journal entry already posted; balance recalculates on next fetch
      }
    }

    return {
      settlement_reference: refNo,
      settlement_type: settlementType,
      journal_entry_id: journalEntry._id,
      amount: data.amount,
      tax_code: data.tax_code || settlementType.toUpperCase(),
      settlement_date: data.settlement_date,
      journal_entry: journalEntry,
    };
  }

  // ── TAX CALCULATION HELPERS ─────────────────────────────────────────

  /**
   * Calculate VAT amount from a base amount
   */
  static calculateVat(baseAmount, taxCodeOrRate) {
    if (typeof taxCodeOrRate === "number") {
      return baseAmount * (taxCodeOrRate / 100);
    }
    // If it's a string code, we'd need to look up the rate
    // For now, return 0 - caller should provide the rate
    return 0;
  }

  /**
   * Extract VAT from a gross amount
   */
  static extractVatFromGross(grossAmount, taxRatePct) {
    const vatRate = taxRatePct / 100;
    const vatAmount = grossAmount * (vatRate / (1 + vatRate));
    const netAmount = grossAmount - vatAmount;
    return {
      gross: grossAmount,
      net: netAmount,
      vat: vatAmount,
      rate_pct: taxRatePct,
    };
  }

  // ── CORPORATE INCOME TAX ACCRUAL ───────────────────────────────────
  /**
   * Post income tax accrual journal entry.
   * Creates the double-entry that the P&L display-only computation misses:
   *   Debit:  Corporate Tax (6400) — P&L expense
   *   Credit: Income Tax Payable (2400) — balance sheet liability
   *
   * @param {string} companyId
   * @param {object} data — { amount, accrual_date, period_description, rate_pct }
   * @param {string} userId
   */
  static async postIncomeTaxAccrual(companyId, data, userId) {
    const { amount, accrual_date, period_description, rate_pct } = data;

    if (!amount || amount <= 0) {
      throw new Error("TAX_AMOUNT_REQUIRED: Income tax amount must be positive");
    }

    const { DEFAULT_ACCOUNTS } = require("../constants/chartOfAccounts");
    const refNo = await SequenceService.nextSequence(companyId, "tax_accrual");
    const narration =
      period_description || `Income Tax Accrual - TXAC#${refNo}`;

    const journalEntry = await JournalService.createEntry(companyId, userId, {
      date: accrual_date || new Date(),
      description: narration,
      sourceType: "tax_accrual",
      sourceId: `taxaccrual_${companyId}_${refNo}`,
      sourceReference: `TXAC#${refNo}`,
      lines: [
        JournalService.createDebitLine(
          DEFAULT_ACCOUNTS.corporateTax,
          amount,
          `Corporate Income Tax${rate_pct ? ` @ ${rate_pct}%` : ""}`,
        ),
        JournalService.createCreditLine(
          DEFAULT_ACCOUNTS.incomeTaxPayable,
          amount,
          `Income Tax Payable${rate_pct ? ` @ ${rate_pct}%` : ""}`,
        ),
      ],
      isAutoGenerated: true,
      sourceData: {
        taxType: "corporate_income",
        taxCode: "corporate_income_tax",
        taxRate: rate_pct || 0,
        grossAmount: amount,
        netAmount: amount,
      },
    });

    return {
      accrual_reference: refNo,
      journal_entry_id: journalEntry._id,
      amount,
      tax_code: "corporate_income_tax",
      accrual_date: accrual_date || new Date(),
      journal_entry: journalEntry,
    };
  }
}

module.exports = TaxService;
