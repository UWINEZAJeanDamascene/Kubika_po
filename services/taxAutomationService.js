const mongoose = require('mongoose');
const TaxRate = require('../models/TaxRate');
const { DEFAULT_ACCOUNTS, validateTaxAccount, getTaxSubtype } = require('../constants/chartOfAccounts');

/**
 * TaxAutomationService
 *
 * Centralized service for computing tax amounts and generating journal entry
 * tax lines. Every module MUST call this service instead of hardcoding tax
 * calculations or journal entry tax lines.
 *
 * All monetary amounts are rounded to 2 decimal places PER LINE before
 * summation — never sum unrounded values then round at the end.
 */
class TaxAutomationService {

  // ── ROUNDING HELPER ────────────────────────────────────────────────

  /**
   * Round a monetary value to 2 decimal places.
   * Uses the standard banker's rounding approach: Math.round(value * 100) / 100
   */
  static round(amount) {
    if (amount == null || isNaN(amount)) return 0;
    return Math.round(Number(amount) * 100) / 100;
  }

  // ── TAX RATE LOOKUP ────────────────────────────────────────────────

  /**
   * Find the active tax rate for a company effective on a given date.
   * Returns the rate where effective_from <= date and (effective_to is null or effective_to > date).
   *
   * @param {String} companyId - Company ID
   * @param {Object} options
   * @param {String} options.taxRateId - Explicit tax rate ID to use
   * @param {String} options.code - Tax code to look up (e.g. 'VAT18')
   * @param {Date} options.date - Transaction date (defaults to now)
   * @param {String} options.type - Filter by tax type (e.g. 'vat')
   * @returns {Object|null} TaxRate document or null
   */
  static async getActiveTaxRate(companyId, options = {}) {
    const { taxRateId, code, date = new Date(), type } = options;

    const query = {
      company: companyId,
      is_active: true,
      effective_from: { $lte: date },
      $or: [
        { effective_to: null },
        { effective_to: { $gt: date } }
      ]
    };

    if (taxRateId) {
      query._id = taxRateId;
    } else if (code) {
      query.code = code.toUpperCase();
    }

    if (type) {
      query.type = type;
    }

    const rate = await TaxRate.findOne(query);
    return rate;
  }

  /**
   * Validate that a tax rate's accounts are properly configured.
   * Checks that input_account_code has subtype vat_input and
   * output_account_code has subtype vat_output.
   *
   * @param {Object} taxRate - TaxRate document
   * @returns {Object} { valid: true } or { valid: false, reason, details }
   */
  static validateTaxRateAccounts(taxRate) {
    if (!taxRate) return { valid: false, reason: 'TAX_RATE_NOT_FOUND' };

    const inputCheck = validateTaxAccount(taxRate.input_account_code, 'vat_input');
    if (!inputCheck.valid) {
      return {
        valid: false,
        reason: 'TAX_ACCOUNT_MISCONFIGURED',
        details: {
          field: 'input_account_code',
          accountCode: taxRate.input_account_code,
          expected: 'vat_input',
          actual: inputCheck.actualSubtype
        }
      };
    }

    const outputCheck = validateTaxAccount(taxRate.output_account_code, 'vat_output');
    if (!outputCheck.valid) {
      return {
        valid: false,
        reason: 'TAX_ACCOUNT_MISCONFIGURED',
        details: {
          field: 'output_account_code',
          accountCode: taxRate.output_account_code,
          expected: 'vat_output',
          actual: outputCheck.actualSubtype
        }
      };
    }

    return { valid: true };
  }

  /**
   * Check if a tax rate is expired for a given transaction date.
   * Returns { expired: true } if effective_to is set and <= transaction date.
   */
  static isRateExpired(taxRate, transactionDate) {
    if (!taxRate) return { expired: false };
    if (taxRate.effective_to && new Date(taxRate.effective_to) <= new Date(transactionDate)) {
      return {
        expired: true,
        reason: 'TAX_RATE_EXPIRED',
        effective_to: taxRate.effective_to
      };
    }
    return { expired: false };
  }

  // ── CORE COMPUTE: PURCHASE TAX (GRN) ──────────────────────────────

  /**
   * Compute input VAT for a Goods Received Note.
   *
   * Journal Entry:
   *   DR Inventory (cost excluding VAT)  — per product line
   *   DR VAT Input (tax amount)          — if taxable
   *   CR Accounts Payable (total)        — net + tax
   *
   * @param {String} companyId
   * @param {Array} lines - Array of { netAmount, taxRatePct, taxRateId, description, product }
   * @param {Date} transactionDate
   * @returns {Object} { lines, totals, taxRate }
   */
  static async computePurchaseTax(companyId, lines, transactionDate = new Date()) {
    const result = {
      lines: [],
      totals: { net: 0, tax: 0, gross: 0 },
      taxRate: null,
      journalLines: []
    };

    if (!lines || lines.length === 0) return result;

    // Build journal lines per product line
    let totalNet = 0;
    let totalTax = 0;

    for (const line of lines) {
      const netAmount = this.round(line.netAmount || 0);
      const taxRatePct = line.taxRatePct || 0;
      const taxAmount = this.round(netAmount * (taxRatePct / 100));

      totalNet = this.round(totalNet + netAmount);
      totalTax = this.round(totalTax + taxAmount);

      result.lines.push({
        netAmount,
        taxRatePct,
        taxAmount,
        description: line.description || '',
        productId: line.productId || null
      });
    }

    const totalGross = this.round(totalNet + totalTax);
    result.totals = { net: totalNet, tax: totalTax, gross: totalGross };

    // Build journal lines
    // DR Inventory — total net
    if (totalNet > 0) {
      result.journalLines.push({
        accountCode: DEFAULT_ACCOUNTS.inventory,
        accountName: 'Inventory',
        description: 'Goods received - inventory at cost',
        debit: totalNet,
        credit: 0
      });
    }

    // DR VAT Input — total tax (use new account 2210)
    if (totalTax > 0) {
      result.journalLines.push({
        accountCode: DEFAULT_ACCOUNTS.vatInput || '2210',
        accountName: 'VAT Input',
        description: 'Input VAT on purchases',
        debit: totalTax,
        credit: 0
      });
    }

    // CR Accounts Payable — total gross
    if (totalGross > 0) {
      result.journalLines.push({
        accountCode: DEFAULT_ACCOUNTS.accountsPayable,
        accountName: 'Accounts Payable',
        description: 'Payable for goods received',
        debit: 0,
        credit: totalGross
      });
    }

    return result;
  }

  // ── CORE COMPUTE: REVERSE PURCHASE TAX (Purchase Return) ──────────

  /**
   * Reverse input VAT on a purchase return.
   * Uses the EXACT original tax amounts from the GRN lines — never recalculates.
   *
   * Journal Entry:
   *   DR Accounts Payable (total including VAT)
   *   CR Inventory (cost excluding VAT)
   *   CR VAT Input (original tax amount)
   *
   * @param {String} companyId
   * @param {Array} originalLines - Array of { netAmount, originalTaxAmount, description }
   * @returns {Object} { lines, totals, journalLines }
   */
  static async reversePurchaseTax(companyId, originalLines) {
    const result = {
      lines: [],
      totals: { net: 0, tax: 0, gross: 0 },
      journalLines: []
    };

    if (!originalLines || originalLines.length === 0) return result;

    let totalNet = 0;
    let totalTax = 0;

    for (const line of originalLines) {
      const netAmount = this.round(line.netAmount || 0);
      const taxAmount = this.round(line.originalTaxAmount || 0);

      totalNet = this.round(totalNet + netAmount);
      totalTax = this.round(totalTax + taxAmount);

      result.lines.push({
        netAmount,
        originalTaxAmount: taxAmount,
        description: line.description || ''
      });
    }

    const totalGross = this.round(totalNet + totalTax);
    result.totals = { net: totalNet, tax: totalTax, gross: totalGross };

    // DR Accounts Payable — total gross
    if (totalGross > 0) {
      result.journalLines.push({
        accountCode: DEFAULT_ACCOUNTS.accountsPayable,
        accountName: 'Accounts Payable',
        description: 'Reversal of payable on purchase return',
        debit: totalGross,
        credit: 0
      });
    }

    // CR Purchase Returns — net amount (contra-COGS, flows to P&L)
    if (totalNet > 0) {
      result.journalLines.push({
        accountCode: DEFAULT_ACCOUNTS.purchaseReturns || '5200',
        accountName: 'Purchase Returns',
        description: 'Reversal of purchases on purchase return',
        debit: 0,
        credit: totalNet
      });
    }

    // CR VAT Input — original tax amount (reverses the debit from GRN)
    if (totalTax > 0) {
      result.journalLines.push({
        accountCode: DEFAULT_ACCOUNTS.vatInput || '2210',
        accountName: 'VAT Input',
        description: 'Reversal of input VAT on purchase return',
        debit: 0,
        credit: totalTax
      });
    }

    return result;
  }

  // ── CORE COMPUTE: SALES TAX (Invoice) ─────────────────────────────

  /**
   * Compute output VAT for a sales invoice.
   *
   * Journal Entry:
   *   DR Accounts Receivable (total including VAT)
   *   CR Revenue (net excluding VAT)
   *   CR VAT Output (tax amount)
   *
   * @param {String} companyId
   * @param {Array} lines - Array of { netAmount, taxRatePct, taxRateId, description, product }
   * @param {Date} transactionDate
   * @returns {Object} { lines, totals, journalLines }
   */
  static async computeSalesTax(companyId, lines, transactionDate = new Date()) {
    const result = {
      lines: [],
      totals: { net: 0, tax: 0, gross: 0 },
      journalLines: []
    };

    if (!lines || lines.length === 0) return result;

    let totalNet = 0;
    let totalTax = 0;

    for (const line of lines) {
      const netAmount = this.round(line.netAmount || 0);
      const taxRatePct = line.taxRatePct || 0;
      const taxAmount = this.round(netAmount * (taxRatePct / 100));

      totalNet = this.round(totalNet + netAmount);
      totalTax = this.round(totalTax + taxAmount);

      result.lines.push({
        netAmount,
        taxRatePct,
        taxAmount,
        description: line.description || '',
        productId: line.productId || null
      });
    }

    const totalGross = this.round(totalNet + totalTax);
    result.totals = { net: totalNet, tax: totalTax, gross: totalGross };

    // DR Accounts Receivable — total gross
    if (totalGross > 0) {
      result.journalLines.push({
        accountCode: DEFAULT_ACCOUNTS.accountsReceivable,
        accountName: 'Accounts Receivable',
        description: 'Invoice amount due',
        debit: totalGross,
        credit: 0
      });
    }

    // CR Revenue — net amount
    if (totalNet > 0) {
      result.journalLines.push({
        accountCode: DEFAULT_ACCOUNTS.salesRevenue,
        accountName: 'Sales Revenue',
        description: 'Revenue from sales',
        debit: 0,
        credit: totalNet
      });
    }

    // CR VAT Output — tax amount
    if (totalTax > 0) {
      result.journalLines.push({
        accountCode: DEFAULT_ACCOUNTS.vatOutput || '2220',
        accountName: 'VAT Output',
        description: 'Output VAT on sales',
        debit: 0,
        credit: totalTax
      });
    }

    return result;
  }

  // ── CORE COMPUTE: REVERSE SALES TAX (Credit Note) ─────────────────

  /**
   * Reverse output VAT on a credit note.
   * Uses the EXACT original tax amounts from the invoice lines — never recalculates.
   *
   * Journal Entry:
   *   DR Revenue (net excluding VAT)
   *   DR VAT Output (tax amount reversed)
   *   CR Accounts Receivable (total including VAT)
   *
   * @param {String} companyId
   * @param {Array} originalLines - Array of { netAmount, originalTaxAmount, description }
   * @returns {Object} { lines, totals, journalLines }
   */
  static async reverseSalesTax(companyId, originalLines) {
    const result = {
      lines: [],
      totals: { net: 0, tax: 0, gross: 0 },
      journalLines: []
    };

    if (!originalLines || originalLines.length === 0) return result;

    let totalNet = 0;
    let totalTax = 0;

    for (const line of originalLines) {
      const netAmount = this.round(line.netAmount || 0);
      const taxAmount = this.round(line.originalTaxAmount || 0);

      totalNet = this.round(totalNet + netAmount);
      totalTax = this.round(totalTax + taxAmount);

      result.lines.push({
        netAmount,
        originalTaxAmount: taxAmount,
        description: line.description || ''
      });
    }

    const totalGross = this.round(totalNet + totalTax);
    result.totals = { net: totalNet, tax: totalTax, gross: totalGross };

    // DR Revenue — net amount
    if (totalNet > 0) {
      result.journalLines.push({
        accountCode: DEFAULT_ACCOUNTS.salesRevenue,
        accountName: 'Sales Revenue',
        description: 'Reversal of revenue on credit note',
        debit: totalNet,
        credit: 0
      });
    }

    // DR VAT Output — tax amount (reverses the credit from invoice)
    if (totalTax > 0) {
      result.journalLines.push({
        accountCode: DEFAULT_ACCOUNTS.vatOutput || '2220',
        accountName: 'VAT Output',
        description: 'Reversal of output VAT on credit note',
        debit: totalTax,
        credit: 0
      });
    }

    // CR Accounts Receivable — total gross
    if (totalGross > 0) {
      result.journalLines.push({
        accountCode: DEFAULT_ACCOUNTS.accountsReceivable,
        accountName: 'Accounts Receivable',
        description: 'Reduction of receivable on credit note',
        debit: 0,
        credit: totalGross
      });
    }

    return result;
  }

  // ── CORE COMPUTE: EXPENSE TAX ──────────────────────────────────────

  /**
   * Compute input VAT on an operating expense.
   *
   * Two input modes supported:
   *   1. netAmount + taxRatePct → system computes taxAmount
   *   2. grossAmount + taxRatePct → system back-calculates net and tax
   *
   * Journal Entry:
   *   DR Expense Account (net excluding VAT)
   *   DR VAT Input (tax amount)
   *   CR Payment Source (bank/cash/payable) — total
   *
   * @param {String} companyId
   * @param {Object} expenseData
   * @param {String} expenseData.expenseAccountId - ChartOfAccount _id for the expense
   * @param {String} expenseData.expenseAccountCode - ChartOfAccount code for the expense
   * @param {Number} expenseData.netAmount - Amount excluding tax (if known)
   * @param {Number} expenseData.grossAmount - Amount including tax (if known)
   * @param {Number} expenseData.taxRatePct - Tax rate percentage
   * @param {String} expenseData.taxAccountId - ChartOfAccount _id for the tax account (optional)
   * @param {Date} transactionDate
   * @returns {Object} { netAmount, taxAmount, grossAmount, journalLines }
   */
  static async computeExpenseTax(companyId, expenseData, transactionDate = new Date()) {
    const { expenseAccountId, expenseAccountCode, netAmount, grossAmount, taxRatePct = 0, taxAccountId } = expenseData;

    let computedNet = 0;
    let computedTax = 0;
    let computedGross = 0;

    if (netAmount != null) {
      // Mode 1: Net amount provided, compute tax
      computedNet = this.round(netAmount);
      computedTax = this.round(computedNet * (taxRatePct / 100));
      computedGross = this.round(computedNet + computedTax);
    } else if (grossAmount != null) {
      // Mode 2: Gross amount provided, back-calculate
      computedGross = this.round(grossAmount);
      computedNet = this.round(computedGross / (1 + taxRatePct / 100));
      computedTax = this.round(computedGross - computedNet);
    }

    const result = {
      netAmount: computedNet,
      taxAmount: computedTax,
      grossAmount: computedGross,
      journalLines: []
    };

    // DR Expense Account — net amount
    if (computedNet > 0) {
      result.journalLines.push({
        accountCode: expenseAccountCode || '6100',
        accountName: 'Expense',
        description: 'Operating expense',
        debit: computedNet,
        credit: 0
      });
    }

    // DR VAT Input — tax amount
    if (computedTax > 0) {
      result.journalLines.push({
        accountCode: DEFAULT_ACCOUNTS.vatInput || '2210',
        accountName: 'VAT Input',
        description: 'Input VAT on expense',
        debit: computedTax,
        credit: 0
      });
    }

    // CR — placeholder for payment source (caller fills in based on payment method)
    if (computedGross > 0) {
      result.journalLines.push({
        accountCode: null, // Caller must set: bank, cash, or payable
        accountName: 'Payment Source',
        description: 'Expense payment',
        debit: 0,
        credit: computedGross
      });
    }

    return result;
  }

  // ── CORE COMPUTE: PAYROLL TAX (PAYE + RSSB) ───────────────────────

  /**
   * Compute PAYE, RSSB employee, and RSSB employer contributions for a payroll run.
   * Uses effective-dated Rwanda rules and the same taxable/contribution bases
   * as payroll generation and preview.
   *
   * @param {String} companyId
   * @param {Object} payrollData
   * @param {Number} payrollData.grossSalary - Gross salary for the employee
   * @param {String} payrollData.salaryAccountId - Account code for salary expense
   * @param {String} payrollData.bankAccountId - Account code for bank
   * @param {String} payrollData.payeAccountId - Account code for PAYE payable (default 2230)
   * @param {String} payrollData.rssbAccountId - Account code for RSSB payable (default 2240)
   * @param {String} payrollData.employerRssbAccountId - Account code for employer RSSB expense (default 6150)
   * @param {Date} payrollData.paymentDate - Payment date for rate lookup
   * @returns {Object} { paye, rssbEmployeePension, rssbEmployeeMaternity, rssbEmployerPension, rssbEmployerMaternity, occupationalHazard, totalDeductions, netPay, journalLines }
   */
  static async computePayrollTax(companyId, payrollData) {
    const { calculateRwandaPayroll } = require("./rwandaPayrollRules");
    const {
      grossSalary = 0,
      salaryAccountId = DEFAULT_ACCOUNTS.salariesWages || '5400',
      bankAccountId = DEFAULT_ACCOUNTS.cashAtBank || '1100',
      payeAccountId = DEFAULT_ACCOUNTS.payePayable || '2230',
      rssbAccountId = DEFAULT_ACCOUNTS.rssbPayable || '2240',
      employerRssbAccountId = DEFAULT_ACCOUNTS.rssbEmployerCost || '6150'
    } = payrollData;

    const calculated = calculateRwandaPayroll({
      salary: { basicSalary: grossSalary },
      employee: payrollData.employee || {},
      additionalIncome: payrollData.additionalIncome || {},
      deductions: payrollData.deductions || {},
      periodDate: payrollData.paymentDate || new Date(),
    });
    const paye = calculated.deductions.paye;
    const rssbEmployeePension = calculated.deductions.rssbEmployeePension;
    const rssbEmployeeMaternity = calculated.deductions.rssbEmployeeMaternity;
    const rssbEmployerPension = calculated.contributions.rssbEmployerPension;
    const rssbEmployerMaternity = calculated.contributions.rssbEmployerMaternity;
    const occupationalHazard = calculated.contributions.occupationalHazard;
    const netPay = calculated.netPay;
    const rssbEmployeeTotal = calculated.deductions.rssbEmployeePension + calculated.deductions.rssbEmployeeMaternity;
    const rssbEmployerTotal = calculated.contributions.totalEmployerContributions;
    const totalDeductions = calculated.deductions.totalDeductions;
    const totalRssbPayable = this.round(rssbEmployeeTotal + rssbEmployerTotal);

    const result = {
      paye,
      rssbEmployeePension,
      rssbEmployeeMaternity,
      rssbEmployeeTotal,
      rssbEmployerPension,
      rssbEmployerMaternity,
      occupationalHazard,
      taxableBase: calculated.taxableBase,
      grossRemuneration: calculated.grossRemuneration,
      ruleVersion: calculated.ruleVersion,
      ruleEffectiveDate: calculated.ruleEffectiveDate,
      rssbBases: calculated.rssbBases,
      rssbEmployerTotal,
      totalRssbPayable,
      totalDeductions,
      netPay,
      journalLines: []
    };

    // ── Journal Entry Lines ────────────────────────────────────────
    // DR Salaries & Wages — gross salary
    if (calculated.cashGrossSalary > 0) {
      result.journalLines.push({
        accountCode: salaryAccountId,
        accountName: 'Salaries & Wages',
        description: 'Gross salary',
        debit: calculated.cashGrossSalary,
        credit: 0
      });
    }

    // DR RSSB Employer Cost — employer statutory contributions
    if (rssbEmployerTotal > 0) {
      result.journalLines.push({
        accountCode: employerRssbAccountId,
        accountName: 'RSSB Employer Cost',
        description: 'Employer RSSB contributions',
        debit: rssbEmployerTotal,
        credit: 0
      });
    }

    // CR PAYE Payable — withheld tax
    if (paye > 0) {
      result.journalLines.push({
        accountCode: payeAccountId,
        accountName: 'PAYE Tax Payable',
        description: 'PAYE tax withheld',
        debit: 0,
        credit: paye
      });
    }

    // CR RSSB Payable — employee + employer combined
    if (totalRssbPayable > 0) {
      result.journalLines.push({
        accountCode: rssbAccountId,
        accountName: 'RSSB Payable',
        description: 'RSSB employee & employer contributions',
        debit: 0,
        credit: totalRssbPayable
      });
    }

    if (calculated.deductions.totalOtherDeductions > 0) {
      result.journalLines.push({
        accountCode: DEFAULT_ACCOUNTS.accruedExpenses || '2600',
        accountName: 'Employee Deductions Payable',
        description: 'Employee non-statutory deductions payable',
        debit: 0,
        credit: calculated.deductions.totalOtherDeductions
      });
    }

    // CR Bank — net pay to employee
    if (netPay > 0) {
      result.journalLines.push({
        accountCode: bankAccountId,
        accountName: 'Cash at Bank',
        description: 'Net salary payment',
        debit: 0,
        credit: netPay
      });
    }

    return result;
  }

  // ── SETTLEMENT: VAT ────────────────────────────────────────────────

  /**
   * Generate journal lines for a VAT settlement (paying net VAT to RRA).
   *
   * Journal Entry:
   *   DR VAT Output (clears the liability)
   *   CR Bank (payment)
   *
   * @param {String} companyId
   * @param {Number} amount - Settlement amount
   * @param {String} bankAccountCode - Bank account code (default 1100)
   * @returns {Object} { journalLines }
   */
  static computeVatSettlement(companyId, amount, bankAccountCode = DEFAULT_ACCOUNTS.cashAtBank || '1100') {
    const settledAmount = this.round(amount);

    return {
      journalLines: [
        {
          accountCode: DEFAULT_ACCOUNTS.vatOutput || '2220',
          accountName: 'VAT Output',
          description: 'VAT settlement to RRA',
          debit: settledAmount,
          credit: 0
        },
        {
          accountCode: bankAccountCode,
          accountName: 'Cash at Bank',
          description: 'VAT payment to RRA',
          debit: 0,
          credit: settledAmount
        }
      ]
    };
  }

  // ── SETTLEMENT: PAYE ───────────────────────────────────────────────

  /**
   * Generate journal lines for a PAYE settlement.
   *
   * Journal Entry:
   *   DR PAYE Tax Payable
   *   CR Bank
   */
  static computePayeSettlement(companyId, amount, bankAccountCode = DEFAULT_ACCOUNTS.cashAtBank || '1100') {
    const settledAmount = this.round(amount);

    return {
      journalLines: [
        {
          accountCode: DEFAULT_ACCOUNTS.payePayable || '2230',
          accountName: 'PAYE Tax Payable',
          description: 'PAYE settlement to RRA',
          debit: settledAmount,
          credit: 0
        },
        {
          accountCode: bankAccountCode,
          accountName: 'Cash at Bank',
          description: 'PAYE payment to RRA',
          debit: 0,
          credit: settledAmount
        }
      ]
    };
  }

  // ── SETTLEMENT: RSSB ───────────────────────────────────────────────

  /**
   * Generate journal lines for an RSSB settlement.
   *
   * Journal Entry:
   *   DR RSSB Payable
   *   CR Bank
   */
  static computeRssbSettlement(companyId, amount, bankAccountCode = DEFAULT_ACCOUNTS.cashAtBank || '1100') {
    const settledAmount = this.round(amount);

    return {
      journalLines: [
        {
          accountCode: DEFAULT_ACCOUNTS.rssbPayable || '2240',
          accountName: 'RSSB Payable',
          description: 'RSSB settlement',
          debit: settledAmount,
          credit: 0
        },
        {
          accountCode: bankAccountCode,
          accountName: 'Cash at Bank',
          description: 'RSSB payment',
          debit: 0,
          credit: settledAmount
        }
      ]
    };
  }

  // ── PREVIEW (for frontend live calculations) ──────────────────────

  /**
   * Preview a tax calculation without posting anything.
   * Used by the frontend to show live tax amounts before a transaction is confirmed.
   *
   * @param {String} companyId
   * @param {String} transactionType - 'purchase', 'sale', 'expense', 'payroll', 'vat_settlement', 'paye_settlement', 'rssb_settlement'
   * @param {Object} data - Transaction-specific data
   * @returns {Object} { computedTax, journalLines, breakdown }
   */
  static async preview(companyId, transactionType, data) {
    switch (transactionType) {
      case 'purchase': {
        const lines = data.lines || [{ netAmount: data.amount || 0, taxRatePct: data.taxRatePct || 0 }];
        const result = await this.computePurchaseTax(companyId, lines, data.date);
        return {
          computedTax: result.totals.tax,
          gross: result.totals.gross,
          journalLines: result.journalLines,
          breakdown: result.lines
        };
      }

      case 'sale': {
        const lines = data.lines || [{ netAmount: data.amount || 0, taxRatePct: data.taxRatePct || 0 }];
        const result = await this.computeSalesTax(companyId, lines, data.date);
        return {
          computedTax: result.totals.tax,
          gross: result.totals.gross,
          journalLines: result.journalLines,
          breakdown: result.lines
        };
      }

      case 'expense': {
        const result = await this.computeExpenseTax(companyId, data);
        return {
          computedTax: result.taxAmount,
          gross: result.grossAmount,
          journalLines: result.journalLines,
          breakdown: { net: result.netAmount, tax: result.taxAmount, gross: result.grossAmount }
        };
      }

      case 'payroll': {
        const result = await this.computePayrollTax(companyId, data);
        return {
          computedTax: result.totalDeductions,
          gross: data.grossSalary,
          journalLines: result.journalLines,
          breakdown: {
            paye: result.paye,
            rssbEmployee: result.rssbEmployeeTotal,
            rssbEmployer: result.rssbEmployerTotal,
            netPay: result.netPay
          }
        };
      }

      case 'vat_settlement': {
        const result = this.computeVatSettlement(companyId, data.amount, data.bankAccountCode);
        return {
          computedTax: data.amount,
          gross: data.amount,
          journalLines: result.journalLines,
          breakdown: { type: 'vat', amount: data.amount }
        };
      }

      case 'paye_settlement': {
        const result = this.computePayeSettlement(companyId, data.amount, data.bankAccountCode);
        return {
          computedTax: data.amount,
          gross: data.amount,
          journalLines: result.journalLines,
          breakdown: { type: 'paye', amount: data.amount }
        };
      }

      case 'rssb_settlement': {
        const result = this.computeRssbSettlement(companyId, data.amount, data.bankAccountCode);
        return {
          computedTax: data.amount,
          gross: data.amount,
          journalLines: result.journalLines,
          breakdown: { type: 'rssb', amount: data.amount }
        };
      }

      default:
        throw new Error(`Unknown transaction type: ${transactionType}`);
    }
  }

  // ── BALANCE CHECK ──────────────────────────────────────────────────

  /**
   * Verify that a set of journal lines is balanced (total DR = total CR).
   * Throws an error if unbalanced.
   *
   * @param {Array} journalLines - Array of { debit, credit }
   * @param {String} context - Description for error message
   * @returns {Object} { balanced: true, totalDebit, totalCredit }
   */
  static assertBalanced(journalLines, context = 'journal entry') {
    let totalDebit = 0;
    let totalCredit = 0;

    for (const line of journalLines) {
      totalDebit = this.round(totalDebit + (line.debit || 0));
      totalCredit = this.round(totalCredit + (line.credit || 0));
    }

    const diff = this.round(totalDebit - totalCredit);
    if (Math.abs(diff) > 0.01) {
      throw new Error(
        `JOURNAL_UNBALANCED: ${context} — DR=${totalDebit}, CR=${totalCredit}, diff=${diff}`
      );
    }

    return { balanced: true, totalDebit, totalCredit };
  }
}

module.exports = TaxAutomationService;
