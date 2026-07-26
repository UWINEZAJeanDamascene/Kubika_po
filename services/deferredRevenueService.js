const DeferredRevenue = require('../models/DeferredRevenue');
const JournalService = require('./journalService');
const SequenceService = require('./sequenceService');
const { DEFAULT_ACCOUNTS } = require('../constants/chartOfAccounts');
const { BankAccount } = require('../models/BankAccount');

class DeferredRevenueService {
  static async getNextReference(companyId) {
    const seq = await SequenceService.nextSequence(companyId, 'deferred_revenue');
    return `DR-${seq}`;
  }

  static async getAll(companyId, filters = {}) {
    const query = { company: companyId };
    if (filters.status) query.status = filters.status;
    if (filters.search) {
      query.$or = [
        { customer: { $regex: filters.search, $options: 'i' } },
        { description: { $regex: filters.search, $options: 'i' } },
        { referenceNo: { $regex: filters.search, $options: 'i' } }
      ];
    }

    const items = await DeferredRevenue.find(query)
      .sort({ createdAt: -1 })
      .populate('journalEntryId', 'entryNumber date status')
      .populate('createdBy', 'name email');

    return items;
  }

  static async getById(companyId, id) {
    return DeferredRevenue.findOne({ _id: id, company: companyId })
      .populate('journalEntryId', 'entryNumber date status')
      .populate('recognitions.journalEntryId', 'entryNumber date status')
      .populate('createdBy', 'name email');
  }

  static async create(companyId, userId, data) {
    const referenceNo = data.referenceNo || await this.getNextReference(companyId);

    const item = new DeferredRevenue({
      company: companyId,
      referenceNo,
      customer: data.customer || '',
      description: data.description,
      totalAmount: data.totalAmount,
      revenueAccountCode: data.revenueAccountCode,
      paymentMethod: data.paymentMethod || 'cash',
      bankAccountId: data.bankAccountId || null,
      startDate: data.startDate,
      endDate: data.endDate,
      frequency: data.frequency || 'monthly',
      remainingBalance: data.totalAmount,
      totalRecognized: 0,
      notes: data.notes || '',
      createdBy: userId
    });

    await item.save();

    // Generate recognition schedule first (matches prepaid expense pattern)
    await this._generateRecognitionSchedule(item);
    await item.save();

    // Post initial journal entry: Dr Cash/Bank / Cr Deferred Revenue
    const journalEntry = await this._postInitialJournal(companyId, userId, item);
    item.journalEntryId = journalEntry._id;
    await item.save();

    // Create BankTransaction when paid into a specific bank account
    if (item.bankAccountId) {
      try {
        const bankAccount = await BankAccount.findById(item.bankAccountId);
        if (bankAccount) {
          await bankAccount.addTransaction({
            type: 'deposit',
            amount: item.totalAmount,
            description: `Deferred revenue received: ${item.referenceNo}`,
            date: item.startDate || new Date(),
            referenceNumber: item.referenceNo,
            referenceType: 'DeferredRevenue',
            reference: item._id,
            createdBy: userId,
            notes: `Customer prepayment — ${item.description}`,
            journalEntryId: journalEntry._id,
          });
        }
      } catch (btErr) {
        console.error('BankTransaction creation failed for deferred revenue:', btErr.message);
        // Non-fatal — journal entry already posted
      }
    }

    return item;
  }

  static async postRecognition(companyId, userId, itemId, recognitionId) {
    const item = await DeferredRevenue.findOne({ _id: itemId, company: companyId });
    if (!item) throw new Error('NOT_FOUND');

    const recognition = (item.recognitions || []).find((r) => String(r._id) === String(recognitionId));
    if (!recognition) throw new Error('RECOGNITION_NOT_FOUND');
    if (recognition.status === 'posted') throw new Error('ALREADY_POSTED');

    // Post journal entry: Dr Deferred Revenue / Cr Service Revenue
    const journalEntry = await this._postRecognitionJournal(companyId, userId, item, recognition);
    recognition.journalEntryId = String(journalEntry._id);
    recognition.status = 'posted';
    // The schedule is a JSON column, so reassign it for the change to persist.
    item.recognitions = [...item.recognitions];

    item.totalRecognized += recognition.amount;
    item.remainingBalance = Math.max(0, item.totalAmount - item.totalRecognized);

    if (item.remainingBalance <= 0.01) {
      item.status = 'fully_recognized';
    }

    await item.save();
    return item;
  }

  static async delete(companyId, id) {
    const item = await DeferredRevenue.findOne({ _id: id, company: companyId });
    if (!item) throw new Error('NOT_FOUND');
    if (item.totalRecognized > 0) throw new Error('CANNOT_DELETE_RECOGNIZED');

    await DeferredRevenue.deleteOne({ _id: id, company: companyId });
    return { deleted: true };
  }

  // ── Private helpers ───────────────────────────────────────────────

  static async _postInitialJournal(companyId, userId, item) {
    const lines = [];

    // Determine cash account
    let cashAccount = DEFAULT_ACCOUNTS.cashInHand;
    if (item.paymentMethod === 'bank_transfer' || item.paymentMethod === 'cheque') {
      if (item.bankAccountId) {
        const bank = await BankAccount.findById(item.bankAccountId).lean();
        if (bank && bank.ledgerAccountId) cashAccount = bank.ledgerAccountId;
        else cashAccount = DEFAULT_ACCOUNTS.cashAtBank;
      } else {
        cashAccount = DEFAULT_ACCOUNTS.cashAtBank;
      }
    } else if (item.paymentMethod === 'mobile_money') {
      if (item.bankAccountId) {
        const bank = await BankAccount.findById(item.bankAccountId).lean();
        if (bank && bank.ledgerAccountId) cashAccount = bank.ledgerAccountId;
        else cashAccount = DEFAULT_ACCOUNTS.mtnMoMo;
      } else {
        cashAccount = DEFAULT_ACCOUNTS.mtnMoMo;
      }
    } else if (item.paymentMethod === 'petty_cash') {
      cashAccount = DEFAULT_ACCOUNTS.pettyCash;
    }

    // Dr Cash/Bank
    lines.push(JournalService.createDebitLine(
      cashAccount,
      item.totalAmount,
      `Deferred revenue received - ${item.referenceNo}`
    ));

    // Cr Deferred Revenue (2850)
    lines.push(JournalService.createCreditLine(
      DEFAULT_ACCOUNTS.deferredRevenue,
      item.totalAmount,
      `Customer prepayment recorded - ${item.referenceNo}`
    ));

    return JournalService.createEntry(companyId, userId, {
      date: item.startDate || new Date(),
      description: `Deferred Revenue Recorded - ${item.referenceNo}`,
      sourceType: 'deferred_revenue',
      sourceId: item._id.toString(),
      sourceReference: item.referenceNo,
      lines,
      isAutoGenerated: true
    });
  }

  static async _postRecognitionJournal(companyId, userId, item, recognition) {
    const lines = [];

    // Dr Deferred Revenue (2850)
    lines.push(JournalService.createDebitLine(
      DEFAULT_ACCOUNTS.deferredRevenue,
      recognition.amount,
      `Revenue recognition - ${item.referenceNo}${recognition.description ? ': ' + recognition.description : ''}`
    ));

    // Cr Revenue Account
    lines.push(JournalService.createCreditLine(
      item.revenueAccountCode,
      recognition.amount,
      `Revenue earned - ${item.referenceNo}`
    ));

    return JournalService.createEntry(companyId, userId, {
      date: recognition.date,
      description: `Deferred Revenue Recognition - ${item.referenceNo}`,
      sourceType: 'deferred_revenue_recognition',
      sourceId: `${item._id}_recognition_${recognition._id}`,
      sourceReference: item.referenceNo,
      lines,
      isAutoGenerated: true
    });
  }

  static async _generateRecognitionSchedule(item) {
    const start = new Date(item.startDate);
    const end = new Date(item.endDate);
    const totalMonths = Math.max(1, (end.getFullYear() - start.getFullYear()) * 12 + (end.getMonth() - start.getMonth()) + 1);

    let periods = totalMonths;
    let periodName = 'month';
    if (item.frequency === 'quarterly') {
      periods = Math.ceil(totalMonths / 3);
      periodName = 'quarter';
    } else if (item.frequency === 'annually') {
      periods = Math.ceil(totalMonths / 12);
      periodName = 'year';
    }

    const amountPerPeriod = parseFloat((item.totalAmount / periods).toFixed(2));
    let remainder = parseFloat((item.totalAmount - (amountPerPeriod * periods)).toFixed(2));

    const recognitions = [];
    let currentDate = new Date(start);

    for (let i = 0; i < periods; i++) {
      let periodAmount = amountPerPeriod;
      if (i === periods - 1) {
        periodAmount = parseFloat((amountPerPeriod + remainder).toFixed(2));
      }

      const desc = `${item.description} - ${periodName} ${i + 1} of ${periods}`;
      recognitions.push({
        amount: periodAmount,
        date: new Date(currentDate),
        description: desc,
        status: 'pending',
        createdAt: new Date()
      });

      if (item.frequency === 'monthly') {
        currentDate.setMonth(currentDate.getMonth() + 1);
      } else if (item.frequency === 'quarterly') {
        currentDate.setMonth(currentDate.getMonth() + 3);
      } else {
        currentDate.setFullYear(currentDate.getFullYear() + 1);
      }
    }

    item.recognitions = recognitions;
  }
}

module.exports = DeferredRevenueService;
