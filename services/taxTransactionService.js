const mongoose = require('mongoose');
const TaxTransaction = require('../models/TaxTransaction');
const TaxRate = require('../models/TaxRate');
const { CHART_OF_ACCOUNTS, DEFAULT_ACCOUNTS, isTaxAccount, getTaxSubtype } = require('../constants/chartOfAccounts');
const { isMongoEnabled } = require('./transactionService');

let warnedMongoUnavailable = false;

/**
 * TaxTransaction is still Mongoose-backed. With Mongo disabled every write sits
 * in the driver buffer until it times out, adding ~10s to each sale, so skip the
 * work instead of failing slowly.
 */
function taxLedgerAvailable() {
  if (isMongoEnabled()) return true;
  if (!warnedMongoUnavailable) {
    warnedMongoUnavailable = true;
    console.warn('TaxTransactionService: MongoDB is disabled — tax transaction records are not being written.');
  }
  return false;
}

/**
 * TaxTransactionService
 * 
 * Handles automatic creation and management of TaxTransaction records.
 * This service is called by JournalService whenever a journal entry is created,
 * extracting tax-relevant lines and creating TaxTransaction records.
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
   * 
   * This is the core method called by JournalService after creating a journal entry.
   * It examines each line, checks if the account code is a tax account, and creates
   * a TaxTransaction record if so.
   * 
   * @param {Object} journalEntry - The saved journal entry document
   * @param {Object} options - Additional context
   * @param {String} options.companyId - Company ID
   * @param {String} options.userId - User ID who created the entry
   * @param {String} options.sourceType - Type of source transaction
   * @param {String} options.sourceId - ID of source document
   * @param {String} options.sourceReference - Human-readable reference
   * @param {Object} options.sourceData - Additional data from source (e.g., tax amounts, rates)
   * @param {Object} options.session - Mongoose session for transactions
   * @returns {Array} Created TaxTransaction documents
   */
  static async processJournalEntry(journalEntry, options = {}) {
    const {
      companyId,
      userId,
      sourceType,
      sourceId,
      sourceReference,
      sourceData = {},
      session = null
    } = options;

    if (!companyId || !journalEntry || !journalEntry.lines) {
      return [];
    }

    if (!taxLedgerAvailable()) return [];

    const taxTransactions = [];
    const entryDate = journalEntry.date || new Date();
    const period = {
      month: entryDate.getMonth() + 1,
      year: entryDate.getFullYear()
    };

    // Determine if this is a reversal entry
    const isReversal = journalEntry.sourceType === 'credit_note' || 
                       journalEntry.sourceType === 'purchase_return' ||
                       sourceType === 'credit_note' ||
                       sourceType === 'purchase_return';

    // Process each journal line
    for (const line of journalEntry.lines) {
      const accountCode = line.accountCode;
      const taxInfo = this.TAX_ACCOUNT_MAP[accountCode];
      
      if (!taxInfo) {
        continue; // Not a tax account, skip
      }

      // Determine amount based on whether it's a debit or credit
      const debitAmount = this.coerceAmount(line.debit);
      const creditAmount = this.coerceAmount(line.credit);
      
      // For VAT accounts:
      // - Debit to 2210 (VAT Input) = Input VAT (purchases) - direction: input
      // - Credit to 2220 (VAT Output) = Output VAT (sales) - direction: output
      // - Debit to 2220 (VAT Output) = VAT reversal (credit notes) - direction: input (reverses output)
      // - Credit to 2210 (VAT Input) = Input VAT reversal (purchase returns) - direction: output (reverses input)

      let amount = 0;
      let direction = taxInfo.direction;
      let taxType = taxInfo.taxType;

      if (accountCode === '2210') {
        // VAT Input
        amount = debitAmount; // Debit = Input VAT
        if (creditAmount > 0 && debitAmount === 0) {
          // Reversal of input VAT (purchase return)
          taxType = 'vat_input_reversed';
          direction = 'output'; // Reversal of input = adds to liability
        }
      } else if (accountCode === '2220') {
        // VAT Output (Payable)
        amount = creditAmount; // Credit = Output VAT
        if (debitAmount > 0 && creditAmount === 0) {
          // Reversal of output VAT (credit note)
          taxType = 'vat_output_reversed';
          direction = 'input'; // Reversal of output = reduces liability
        }
      } else if (accountCode === '2240') {
        // RSSB Payable - need to distinguish employee vs employer
        // Check if this came from payroll with employer contribution info
        amount = creditAmount || debitAmount;
        if (sourceData.employerContribution && creditAmount > 0) {
          // This is the employer portion
          taxType = 'rssb_employer';
        } else {
          taxType = 'rssb_employee';
        }
      } else {
        // Other tax accounts (PAYE, corporate income, withholding)
        amount = creditAmount || debitAmount;
      }

      if (amount <= 0) {
        continue; // No tax amount, skip
      }

      // Look up the tax rate if available
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

      // Build the TaxTransaction document
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

    // Bulk create all tax transactions
    if (taxTransactions.length === 0) {
      return [];
    }

    try {
      const saveOptions = session ? { session } : {};
      const created = await TaxTransaction.insertMany(taxTransactions, saveOptions);
      return created;
    } catch (err) {
      console.error('TaxTransactionService.processJournalEntry - Failed to create tax transactions:', err);
      // Don't throw - tax transaction creation failure shouldn't block journal entry creation
      return [];
    }
  }

  /**
   * Create a TaxTransaction directly (without a journal entry).
   * Used for standalone tax events like tax settlements.
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
      session = null
    } = data;

    if (!taxLedgerAvailable()) return null;

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

    const saveOptions = session ? { session } : {};
    return taxTx.save(saveOptions);
  }

  /**
   * Reverse a tax transaction (e.g., when a journal entry is reversed)
   */
  static async reverseTransaction(originalTransactionId, reversalData, options = {}) {
    const { companyId, userId, journalEntryId, session = null } = options;
    
    const original = await TaxTransaction.findOne({
      _id: originalTransactionId,
      company: companyId
    });
    
    if (!original) {
      throw new Error('Original tax transaction not found');
    }

    // Create reversal transaction
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
      taxRateId: original.taxRateId,
      taxCode: original.taxCode,
      period: original.period,
      date: reversalData.date || new Date(),
      description: `Reversal: ${original.description}`,
      status: 'posted',
      reversalOf: original._id,
      createdBy: userId,
      metadata: {
        ...original.metadata,
        isReversal: true,
        originalTransactionId: original._id
      }
    });

    const saveOptions = session ? { session } : {};
    const saved = await reversalTx.save(saveOptions);

    // Mark original as reversed
    original.status = 'reversed';
    await original.save(saveOptions);

    return saved;
  }

  /**
   * Get tax summary for dashboard
   */
  static async getDashboardSummary(companyId, year, month) {
    return TaxTransaction.getDashboardSummary(companyId, year, month);
  }

  /**
   * Get all tax transactions with filtering
   */
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

    const match = {
      company: new mongoose.Types.ObjectId(companyId),
      status
    };

    if (taxType) match.taxType = taxType;
    if (direction) match.direction = direction;
    if (sourceType) match.sourceType = sourceType;
    
    if (startDate || endDate) {
      match.date = {};
      if (startDate) match.date.$gte = new Date(startDate);
      if (endDate) match.date.$lte = new Date(endDate);
    }

    const skip = (page - 1) * limit;
    const sort = { [sortBy]: sortOrder };

    const [transactions, total] = await Promise.all([
      TaxTransaction.find(match)
        .sort(sort)
        .skip(skip)
        .limit(limit)
        .populate('journalEntryId', 'entryNumber date description')
        .populate('taxRateId', 'name code rate_pct')
        .lean(),
      TaxTransaction.countDocuments(match)
    ]);

    return {
      transactions,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit)
      }
    };
  }

  /**
   * Get tax liability breakdown by tax type
   */
  static async getLiabilityBreakdown(companyId, periodStart, periodEnd) {
    const match = {
      company: new mongoose.Types.ObjectId(companyId),
      status: 'posted',
      date: {
        $gte: new Date(periodStart),
        $lte: new Date(periodEnd)
      }
    };

    const result = await TaxTransaction.aggregate([
      { $match: match },
      {
        $group: {
          _id: '$taxType',
          input: {
            $sum: {
              $cond: [{ $eq: ['$direction', 'input'] }, '$amount', 0]
            }
          },
          output: {
            $sum: {
              $cond: [{ $eq: ['$direction', 'output'] }, '$amount', 0]
            }
          },
          withheld: {
            $sum: {
              $cond: [{ $eq: ['$direction', 'withheld'] }, '$amount', 0]
            }
          },
          paid: {
            $sum: {
              $cond: [{ $eq: ['$direction', 'paid'] }, '$amount', 0]
            }
          },
          count: { $sum: 1 }
        }
      },
      { $sort: { _id: 1 } }
    ]);

    // Organize into readable format
    const breakdown = {};
    result.forEach(r => {
      breakdown[r._id] = {
        input: Number(r.input),
        output: Number(r.output),
        withheld: Number(r.withheld),
        paid: Number(r.paid),
        count: r.count,
        net: r._id.startsWith('vat') 
          ? Number(r.output) - Number(r.input) 
          : Number(r.withheld)
      };
    });

    return breakdown;
  }

  /**
   * Get transactions by source type with summary
   */
  static async getBySourceType(companyId, sourceType, options = {}) {
    return TaxTransaction.getBySourceType(companyId, sourceType, options);
  }

  /**
   * Get tax sources summary (all 12 sources in one view)
   */
  static async getTaxSourcesSummary(companyId, periodStart, periodEnd) {
    return TaxTransaction.getTaxSourcesSummary(companyId, periodStart, periodEnd);
  }

  /**
   * Get period-over-period comparison
   */
  static async getPeriodComparison(companyId, year, month) {
    return TaxTransaction.getPeriodComparison(companyId, year, month);
  }

  /**
   * Helper: Coerce value to number
   */
  static coerceAmount(v) {
    if (v == null) return 0;
    if (typeof v === 'number') return v;
    if (typeof v === 'string') return Number(v) || 0;
    if (typeof v === 'object' && v.toString) {
      try { return Number(v.toString()); } catch (e) { return 0; }
    }
    return Number(v) || 0;
  }

  /**
   * Helper: Map source type to standardized value
   */
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
   * Run once during migration to populate historical data.
   */
  static async backfillFromJournalEntries(companyId, options = {}) {
    const { startDate, endDate, batchSize = 100 } = options;
    
    const JournalEntry = require('../models/JournalEntry');
    
    const match = {
      company: new mongoose.Types.ObjectId(companyId),
      status: 'posted'
    };
    
    if (startDate || endDate) {
      match.date = {};
      if (startDate) match.date.$gte = new Date(startDate);
      if (endDate) match.date.$lte = new Date(endDate);
    }

    // Get all journal entries that might have tax lines
    const taxAccountCodes = Object.keys(this.TAX_ACCOUNTS_MAP || this.TAX_ACCOUNT_MAP);
    
    let processed = 0;
    let skipped = 0;
    let failed = 0;
    
    // Process in batches
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
          // Check if this entry already has tax transactions
          const existing = await TaxTransaction.countDocuments({
            journalEntryId: entry._id,
            company: companyId
          });
          
          if (existing > 0) {
            skipped++;
            continue;
          }
          
          // Process the entry
          await this.processJournalEntry(entry, {
            companyId,
            userId: entry.createdBy,
            sourceType: entry.sourceType,
            sourceId: entry.sourceId,
            sourceReference: entry.sourceReference,
            sourceData: {}
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
