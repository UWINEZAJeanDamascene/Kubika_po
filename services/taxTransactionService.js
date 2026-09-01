const TaxTransaction = require('../models/TaxTransaction');
const TaxRate = require('../models/TaxRate');
const { CHART_OF_ACCOUNTS, DEFAULT_ACCOUNTS, isTaxAccount, getTaxSubtype } = require('../constants/chartOfAccounts');
const { dbClient } = require('../lib/prisma');
const { decimalToNumber } = require('../utils/decimalHelpers');
const { toIdString } = require('../utils/objectId');
const { taxTransactionToApi, TAX_TRANSACTION_DEFAULT_INCLUDE } = require('../utils/taxMappers');

/**
 * TaxTransactionService
 *
 * Handles automatic creation and management of TaxTransaction records.
 * This service is called by JournalService whenever a journal entry is created,
 * extracting tax-relevant lines and creating TaxTransaction records.
 *
 * Writes always go to PostgreSQL. A failure rolls back the enclosing journal
 * transaction — tax ledger rows are compliance data and must never be skipped.
 */
class TaxTransactionService {

  /**
   * Map of account codes to tax types and directions.
   * This defines which account codes represent which tax events.
   */
  static TAX_ACCOUNT_MAP = {
    // ── VAT Accounts ──────────────────────────────────────────
    '2210': { taxType: 'vat_input', direction: 'input' },           // VAT Input
    '2220': { taxType: 'vat_output', direction: 'output' },         // VAT Output

    // ── PAYE ─────────────────────────────────────────
    '2230': { taxType: 'paye', direction: 'withheld' },             // PAYE Tax Payable

    // ── RSSB ─────────────────────────────────────────
    '2240': { taxType: 'rssb_employee', direction: 'withheld' },    // RSSB Payable
    '2310': { taxType: 'rssb_employer', direction: 'withheld' },    // Employer Contribution Payable

    // ── Income Tax ────────────────────────────────────────────────────
    '2400': { taxType: 'income_tax', direction: 'withheld' },        // Income Tax Payable
    '2500': { taxType: 'withholding', direction: 'withheld' },      // Withholding Tax Payable
  };

  /**
   * Map source types to their descriptions for better tax transaction labeling
   */
  static SOURCE_TYPE_LABELS = {
    'invoice': 'Sales Invoice',
    'credit_note': 'Credit Note',
    'purchase': 'Purchase / GRN',
    'purchase_return': 'Purchase Return',
    'expense': 'Expense',
    'petty_cash_expense': 'Petty Cash Expense',
    'payroll_run': 'Payroll Run',
    'tax_settlement': 'Tax Settlement',
    'asset_purchase': 'Asset Purchase',
    'manual': 'Manual Entry'
  };

  /**
   * Process journal entry lines and create TaxTransaction records for tax-relevant lines.
   */
  static async processJournalEntry(journalEntry, options = {}) {
    const {
      companyId,
      userId,
      sourceType,
      sourceId,
      sourceReference,
      sourceData = {},
    } = options;

    if (!companyId || !journalEntry || !journalEntry.lines) {
      return [];
    }

    const taxTransactions = [];
    const entryDate = journalEntry.date || new Date();
    const period = {
      month: entryDate.getMonth() + 1,
      year: entryDate.getFullYear()
    };

    // Process each journal line
    for (const line of journalEntry.lines) {
      const accountCode = line.accountCode;
      const taxInfo = this.TAX_ACCOUNT_MAP[accountCode];

      if (!taxInfo) {
        continue; // Not a tax account, skip
      }

      const debitAmount = this.coerceAmount(line.debit);
      const creditAmount = this.coerceAmount(line.credit);

      let amount = 0;
      let direction = taxInfo.direction;
      let taxType = taxInfo.taxType;

      if (accountCode === '2210') {
        amount = debitAmount;
        if (creditAmount > 0 && debitAmount === 0) {
          taxType = 'vat_input_reversed';
          direction = 'output';
        }
      } else if (accountCode === '2220') {
        amount = creditAmount;
        if (debitAmount > 0 && creditAmount === 0) {
          taxType = 'vat_output_reversed';
          direction = 'input';
        }
      } else if (accountCode === '2240') {
        amount = creditAmount || debitAmount;
        if (sourceData.employerContribution && creditAmount > 0) {
          taxType = 'rssb_employer';
        } else {
          taxType = 'rssb_employee';
        }
      } else {
        amount = creditAmount || debitAmount;
      }

      if (amount <= 0) {
        continue;
      }

      let taxRateId = null;
      let taxCode = null;
      let taxRatePct = 0;

      if (sourceData.taxRateId) {
        taxRateId = sourceData.taxRateId;
      }
      if (sourceData.taxCode) {
        taxCode = sourceData.taxCode;
      }
      if (sourceData.taxRate !== undefined) {
        taxRatePct = sourceData.taxRate;
      }

      const taxTx = {
        company: companyId,
        taxType,
        direction,
        amount,
        netAmount: sourceData.netAmount || 0,
        grossAmount: sourceData.grossAmount || 0,
        taxRate: taxRatePct,
        sourceType: this.mapSourceType(journalEntry.sourceType || sourceType),
        sourceId: sourceId || journalEntry.sourceId,
        sourceReference: sourceReference || journalEntry.sourceReference || journalEntry.entryNumber,
        journalEntryId: journalEntry._id,
        journalEntryNumber: journalEntry.entryNumber,
        accountCode,
        taxRateId,
        taxCode,
        period,
        date: entryDate,
        description: line.description || journalEntry.description,
        status: 'posted',
        createdBy: userId || journalEntry.createdBy,
        metadata: {
          journalLineNumber: journalEntry.lines.indexOf(line),
          ...sourceData.metadata
        }
      };

      taxTransactions.push(taxTx);
    }

    if (taxTransactions.length === 0) {
      return [];
    }

    const created = await TaxTransaction.insertMany(taxTransactions);
    return created;
  }

  /**
   * Create a TaxTransaction directly (without a journal entry).
   */
  static async createDirectTransaction(data) {
    const {
      companyId,
      userId,
      taxType,
      direction,
      amount,
      sourceType,
      sourceId,
      sourceReference,
      description,
      date = new Date(),
      accountCode,
      taxRateId,
      taxCode,
      taxRate = 0,
      netAmount = 0,
      grossAmount = 0,
      metadata = {},
    } = data;

    const period = {
      month: date.getMonth() + 1,
      year: date.getFullYear()
    };

    const taxTx = new TaxTransaction({
      company: companyId,
      taxType,
      direction,
      amount,
      netAmount,
      grossAmount,
      taxRate,
      sourceType,
      sourceId,
      sourceReference,
      accountCode,
      taxRateId,
      taxCode,
      period,
      date,
      description,
      status: 'posted',
      createdBy: userId,
      metadata
    });

    return taxTx.save();
  }

  /**
   * Reverse a tax transaction (e.g., when a journal entry is reversed)
   */
  static async reverseTransaction(originalTransactionId, reversalData, options = {}) {
    const { companyId, userId, journalEntryId } = options;

    const original = await TaxTransaction.findOne({
      _id: originalTransactionId,
      company: companyId
    });

    if (!original) {
      throw new Error('Original tax transaction not found');
    }

    const reversalTx = new TaxTransaction({
      company: companyId,
      taxType: original.taxType,
      direction: original.direction === 'input' ? 'output' : 'input',
      amount: original.amount,
      netAmount: original.netAmount,
      grossAmount: original.grossAmount,
      taxRate: original.taxRate,
      sourceType: original.sourceType,
      sourceId: reversalData.sourceId || original.sourceId,
      sourceReference: reversalData.sourceReference || original.sourceReference,
      journalEntryId: journalEntryId,
      accountCode: original.accountCode,
      taxRateId: original.taxRateId?._id || original.taxRateId,
      taxCode: original.taxCode,
      period: original.period,
      date: reversalData.date || new Date(),
      description: `Reversal: ${original.description}`,
      status: 'posted',
      reversalOf: original._id,
      createdBy: userId,
      metadata: {
        ...(original.metadata || {}),
        isReversal: true,
        originalTransactionId: original._id
      }
    });

    const saved = await reversalTx.save();

    original.status = 'reversed';
    await original.save();

    return saved;
  }

  static async getDashboardSummary(companyId, year, month) {
    return TaxTransaction.getDashboardSummary(companyId, year, month);
  }

  static async getTransactions(companyId, filters = {}) {
    const {
      taxType,
      direction,
      sourceType,
      startDate,
      endDate,
      status = 'posted',
      page = 1,
      limit = 50,
      sortBy = 'date',
      sortOrder = -1
    } = filters;

    const where = {
      companyId: toIdString(companyId),
      status,
    };

    if (taxType) where.taxType = taxType;
    if (direction) where.direction = direction;
    if (sourceType) where.sourceType = sourceType;

    if (startDate || endDate) {
      where.date = {};
      if (startDate) where.date.gte = new Date(startDate);
      if (endDate) where.date.lte = new Date(endDate);
    }

    const skip = (page - 1) * limit;
    const orderBy = { [sortBy]: sortOrder === -1 || sortOrder === 'desc' ? 'desc' : 'asc' };

    const [rows, total] = await Promise.all([
      dbClient().taxTransaction.findMany({
        where,
        orderBy,
        skip,
        take: limit,
        include: TAX_TRANSACTION_DEFAULT_INCLUDE,
      }),
      dbClient().taxTransaction.count({ where }),
    ]);

    return {
      transactions: rows.map(taxTransactionToApi),
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit) || 0,
      },
    };
  }

  static async getLiabilityBreakdown(companyId, periodStart, periodEnd) {
    const rows = await dbClient().taxTransaction.groupBy({
      by: ['taxType'],
      where: {
        companyId: toIdString(companyId),
        status: 'posted',
        date: {
          gte: new Date(periodStart),
          lte: new Date(periodEnd),
        },
      },
      _sum: { amount: true },
      _count: { _all: true },
    });

    const directionRows = await dbClient().taxTransaction.groupBy({
      by: ['taxType', 'direction'],
      where: {
        companyId: toIdString(companyId),
        status: 'posted',
        date: {
          gte: new Date(periodStart),
          lte: new Date(periodEnd),
        },
      },
      _sum: { amount: true },
    });

    const breakdown = {};
    for (const row of rows) {
      breakdown[row.taxType] = {
        input: 0,
        output: 0,
        withheld: 0,
        paid: 0,
        count: row._count._all,
        net: 0,
      };
    }

    for (const row of directionRows) {
      if (!breakdown[row.taxType]) {
        breakdown[row.taxType] = {
          input: 0,
          output: 0,
          withheld: 0,
          paid: 0,
          count: 0,
          net: 0,
        };
      }
      breakdown[row.taxType][row.direction] = decimalToNumber(row._sum.amount);
    }

    for (const [taxType, entry] of Object.entries(breakdown)) {
      entry.net = taxType.startsWith('vat')
        ? entry.output - entry.input
        : entry.withheld;
    }

    return breakdown;
  }

  static async getBySourceType(companyId, sourceType, options = {}) {
    return TaxTransaction.getBySourceType(companyId, sourceType, options);
  }

  static async getTaxSourcesSummary(companyId, periodStart, periodEnd) {
    return TaxTransaction.getTaxSourcesSummary(companyId, periodStart, periodEnd);
  }

  static async getPeriodComparison(companyId, year, month) {
    return TaxTransaction.getPeriodComparison(companyId, year, month);
  }

  static coerceAmount(v) {
    if (v == null) return 0;
    if (typeof v === 'number') return v;
    if (typeof v === 'string') return Number(v) || 0;
    if (typeof v === 'object' && v.toString) {
      try { return Number(v.toString()); } catch (e) { return 0; }
    }
    return Number(v) || 0;
  }

  static mapSourceType(sourceType) {
    const mapping = {
      'invoice': 'invoice',
      'credit_note': 'credit_note',
      'purchase': 'purchase',
      'purchase_order': 'purchase_order',
      'purchase_return': 'purchase_return',
      'expense': 'expense',
      'petty_cash_expense': 'petty_cash_expense',
      'payroll': 'payroll_run',
      'payroll_run': 'payroll_run',
      'tax_settlement': 'tax_settlement',
      'tax_payment': 'tax_settlement',
      'asset': 'asset_purchase',
      'asset_purchase': 'asset_purchase',
      'manual': 'manual'
    };
    return mapping[sourceType] || sourceType;
  }

  /**
   * Backfill TaxTransaction records from existing journal entries.
   */
  static async backfillFromJournalEntries(companyId, options = {}) {
    const { startDate, endDate, batchSize = 100 } = options;

    const JournalEntry = require('../models/JournalEntry');
    const companyKey = toIdString(companyId);

    const match = {
      company: companyKey,
      status: 'posted',
    };

    if (startDate || endDate) {
      match.date = {};
      if (startDate) match.date.$gte = new Date(startDate);
      if (endDate) match.date.$lte = new Date(endDate);
    }

    let processed = 0;
    let skipped = 0;
    let failed = 0;

    let hasMore = true;
    let lastId = null;

    while (hasMore) {
      const query = { ...match };
      if (lastId) {
        query._id = { $gt: lastId };
      }

      const entries = await JournalEntry.find(query)
        .sort({ _id: 1 })
        .limit(batchSize)
        .lean();

      if (entries.length === 0) {
        hasMore = false;
        break;
      }

      for (const entry of entries) {
        try {
          const existing = await TaxTransaction.countDocuments({
            journalEntryId: entry._id,
            company: companyKey,
          });

          if (existing > 0) {
            skipped++;
            continue;
          }

          await this.processJournalEntry(entry, {
            companyId: companyKey,
            userId: entry.createdBy,
            sourceType: entry.sourceType,
            sourceId: entry.sourceId,
            sourceReference: entry.sourceReference,
            sourceData: {},
          });

          processed++;
        } catch (err) {
          console.error(`Failed to process journal entry ${entry._id}:`, err.message);
          failed++;
        }
      }

      lastId = entries[entries.length - 1]._id;
    }

    return { processed, skipped, failed };
  }
}

module.exports = TaxTransactionService;
