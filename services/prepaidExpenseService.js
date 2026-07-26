const PrepaidExpense = require('../models/PrepaidExpense');
const JournalService = require('./journalService');
const SequenceService = require('./sequenceService');
const { DEFAULT_ACCOUNTS } = require('../constants/chartOfAccounts');
const { BankAccount } = require('../models/BankAccount');

class PrepaidExpenseService {
  static async getNextReference(companyId) {
    const seq = await SequenceService.nextSequence(companyId, 'prepaid_expense');
    return `PRE-${seq}`;
  }

  static async getAll(companyId, filters = {}) {
    const query = { company: companyId };
    if (filters.status) query.status = filters.status;
    if (filters.search) {
      query.$or = [
        { vendor: { $regex: filters.search, $options: 'i' } },
        { description: { $regex: filters.search, $options: 'i' } },
        { referenceNo: { $regex: filters.search, $options: 'i' } }
      ];
    }

    const advances = await PrepaidExpense.find(query)
      .sort({ createdAt: -1 })
      .populate('journalEntryId', 'entryNumber date status')
      .populate('createdBy', 'name email');

    return advances;
  }

  static async getById(companyId, id) {
    return PrepaidExpense.findOne({ _id: id, company: companyId })
      .populate('journalEntryId', 'entryNumber date status')
      .populate('amortizations.journalEntryId', 'entryNumber date status')
      .populate('createdBy', 'name email');
  }

  static async create(companyId, userId, data) {
    const referenceNo = data.referenceNo || await this.getNextReference(companyId);

    const prepaid = new PrepaidExpense({
      company: companyId,
      referenceNo,
      vendor: data.vendor || '',
      description: data.description,
      totalAmount: data.totalAmount,
      expenseAccountCode: data.expenseAccountCode,
      paymentMethod: data.paymentMethod || 'cash',
      bankAccountId: data.bankAccountId || null,
      startDate: data.startDate,
      endDate: data.endDate,
      frequency: data.frequency || 'monthly',
      remainingBalance: data.totalAmount,
      totalAmortized: 0,
      notes: data.notes || '',
      createdBy: userId
    });

    await prepaid.save();

    // Post initial journal entry: Dr Prepaid Expenses / Cr Cash/Bank
    const journalEntry = await this._postInitialJournal(companyId, userId, prepaid);
    prepaid.journalEntryId = journalEntry._id;
    await prepaid.save();

    // Generate amortization schedule
    await this._generateAmortizationSchedule(prepaid);
    await prepaid.save();

    // Create BankTransaction when paid from a specific bank account
    if (prepaid.bankAccountId) {
      try {
        const bankAccount = await BankAccount.findById(prepaid.bankAccountId);
        if (bankAccount) {
          await bankAccount.addTransaction({
            type: 'withdrawal',
            amount: prepaid.totalAmount,
            description: `Prepaid expense: ${prepaid.referenceNo}`,
            date: prepaid.startDate || new Date(),
            referenceNumber: prepaid.referenceNo,
            referenceType: 'PrepaidExpense',
            reference: prepaid._id,
            createdBy: userId,
            notes: `Prepaid expense payment — ${prepaid.description}`,
            journalEntryId: journalEntry._id,
          });
        }
      } catch (btErr) {
        console.error('BankTransaction creation failed for prepaid expense:', btErr.message);
        // Non-fatal — journal entry already posted
      }
    }

    return prepaid;
  }

  static async postAmortization(companyId, userId, prepaidId, amortizationId) {
    const prepaid = await PrepaidExpense.findOne({ _id: prepaidId, company: companyId });
    if (!prepaid) throw new Error('NOT_FOUND');

    const amortization = (prepaid.amortizations || []).find((a) => String(a._id) === String(amortizationId));
    if (!amortization) throw new Error('AMORTIZATION_NOT_FOUND');
    if (amortization.status === 'posted') throw new Error('ALREADY_POSTED');

    // Post journal entry: Dr Expense / Cr Prepaid Expenses
    const journalEntry = await this._postAmortizationJournal(companyId, userId, prepaid, amortization);
    amortization.journalEntryId = String(journalEntry._id);
    amortization.status = 'posted';
    // The schedule is a JSON column, so reassign it for the change to persist.
    prepaid.amortizations = [...prepaid.amortizations];

    prepaid.totalAmortized += amortization.amount;
    prepaid.remainingBalance = Math.max(0, prepaid.totalAmount - prepaid.totalAmortized);

    if (prepaid.remainingBalance <= 0.01) {
      prepaid.status = 'fully_amortized';
    }

    await prepaid.save();
    return prepaid;
  }

  static async delete(companyId, id) {
    const prepaid = await PrepaidExpense.findOne({ _id: id, company: companyId });
    if (!prepaid) throw new Error('NOT_FOUND');
    if (prepaid.totalAmortized > 0) throw new Error('CANNOT_DELETE_AMORTIZED');

    await PrepaidExpense.deleteOne({ _id: id, company: companyId });
    return { deleted: true };
  }

  // ── Private helpers ───────────────────────────────────────────────

  static async _postInitialJournal(companyId, userId, prepaid) {
    const lines = [];

    // Determine cash account
    let cashAccount = DEFAULT_ACCOUNTS.cashInHand;
    if (prepaid.paymentMethod === 'bank_transfer' || prepaid.paymentMethod === 'cheque') {
      if (prepaid.bankAccountId) {
        const bank = await BankAccount.findById(prepaid.bankAccountId).lean();
        if (bank && bank.ledgerAccountId) cashAccount = bank.ledgerAccountId;
        else cashAccount = DEFAULT_ACCOUNTS.cashAtBank;
      } else {
        cashAccount = DEFAULT_ACCOUNTS.cashAtBank;
      }
    } else if (prepaid.paymentMethod === 'mobile_money') {
      if (prepaid.bankAccountId) {
        const bank = await BankAccount.findById(prepaid.bankAccountId).lean();
        if (bank && bank.ledgerAccountId) cashAccount = bank.ledgerAccountId;
        else cashAccount = DEFAULT_ACCOUNTS.mtnMoMo;
      } else {
        cashAccount = DEFAULT_ACCOUNTS.mtnMoMo;
      }
    } else if (prepaid.paymentMethod === 'petty_cash') {
      cashAccount = DEFAULT_ACCOUNTS.pettyCash;
    }

    // Dr Prepaid Expenses
    lines.push(JournalService.createDebitLine(
      DEFAULT_ACCOUNTS.prepaidExpenses,
      prepaid.totalAmount,
      `Prepaid expense recorded - ${prepaid.referenceNo}`
    ));

    // Cr Cash/Bank/MoMo
    lines.push(JournalService.createCreditLine(
      cashAccount,
      prepaid.totalAmount,
      `Payment for prepaid expense - ${prepaid.referenceNo}`
    ));

    return JournalService.createEntry(companyId, userId, {
      date: prepaid.startDate || new Date(),
      description: `Prepaid Expense Recorded - ${prepaid.referenceNo}`,
      sourceType: 'prepaid_expense',
      sourceId: prepaid._id,
      sourceReference: prepaid.referenceNo,
      lines,
      isAutoGenerated: true
    });
  }

  static async _postAmortizationJournal(companyId, userId, prepaid, amortization) {
    const lines = [];

    // Dr Expense Account
    lines.push(JournalService.createDebitLine(
      prepaid.expenseAccountCode,
      amortization.amount,
      `Amortization - ${prepaid.referenceNo}${amortization.description ? ': ' + amortization.description : ''}`
    ));

    // Cr Prepaid Expenses
    lines.push(JournalService.createCreditLine(
      DEFAULT_ACCOUNTS.prepaidExpenses,
      amortization.amount,
      `Amortization - ${prepaid.referenceNo}`
    ));

    return JournalService.createEntry(companyId, userId, {
      date: amortization.date,
      description: `Prepaid Expense Amortization - ${prepaid.referenceNo}`,
      sourceType: 'prepaid_expense_amortization',
      sourceId: prepaid._id,
      sourceReference: prepaid.referenceNo,
      lines,
      isAutoGenerated: true
    });
  }

  static async _generateAmortizationSchedule(prepaid) {
    const start = new Date(prepaid.startDate);
    const end = new Date(prepaid.endDate);
    const totalMonths = Math.max(1, (end.getFullYear() - start.getFullYear()) * 12 + (end.getMonth() - start.getMonth()) + 1);

    let periods = totalMonths;
    let periodName = 'month';
    if (prepaid.frequency === 'quarterly') {
      periods = Math.ceil(totalMonths / 3);
      periodName = 'quarter';
    } else if (prepaid.frequency === 'annually') {
      periods = Math.ceil(totalMonths / 12);
      periodName = 'year';
    }

    const amountPerPeriod = parseFloat((prepaid.totalAmount / periods).toFixed(2));
    let remainder = parseFloat((prepaid.totalAmount - (amountPerPeriod * periods)).toFixed(2));

    const amortizations = [];
    let currentDate = new Date(start);

    for (let i = 0; i < periods; i++) {
      let periodAmount = amountPerPeriod;
      if (i === periods - 1) {
        periodAmount = parseFloat((amountPerPeriod + remainder).toFixed(2));
      }

      const desc = `${prepaid.description} - ${periodName} ${i + 1} of ${periods}`;
      amortizations.push({
        amount: periodAmount,
        date: new Date(currentDate),
        description: desc,
        status: 'pending',
        createdAt: new Date()
      });

      if (prepaid.frequency === 'monthly') {
        currentDate.setMonth(currentDate.getMonth() + 1);
      } else if (prepaid.frequency === 'quarterly') {
        currentDate.setMonth(currentDate.getMonth() + 3);
      } else {
        currentDate.setFullYear(currentDate.getFullYear() + 1);
      }
    }

    prepaid.amortizations = amortizations;
  }
}

module.exports = PrepaidExpenseService;
