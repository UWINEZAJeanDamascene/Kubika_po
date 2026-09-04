const EmployeeAdvance = require('../models/EmployeeAdvance');
const JournalService = require('./journalService');
const SequenceService = require('./sequenceService');
const { DEFAULT_ACCOUNTS } = require('../constants/chartOfAccounts');
const { BankAccount } = require('../models/BankAccount');
const { dbClient } = require('../lib/prisma');

class EmployeeAdvanceService {
  static async getNextReference(companyId) {
    const seq = await SequenceService.nextSequence(companyId, 'employee_advance');
    return `ADV-${seq}`;
  }

  static async create(companyId, userId, data) {
    const referenceNo = data.referenceNo || await this.getNextReference(companyId);

    const advance = new EmployeeAdvance({
      company: companyId,
      employee: data.employeeId,
      referenceNo,
      description: data.description || '',
      amount: data.amount,
      amountRepaid: 0,
      balance: data.amount,
      issueDate: data.issueDate || new Date(),
      dueDate: data.dueDate || null,
      status: 'issued',
      paymentMethod: data.paymentMethod || 'cash',
      bankAccountId: data.bankAccountId || null,
      notes: data.notes || '',
      createdBy: userId,
      repayments: []
    });

    await advance.save();

    // Post journal entry: Dr Employee Advances / Cr Cash/Bank
    const journalEntry = await this._postIssueJournal(companyId, userId, advance);
    advance.journalEntryId = journalEntry._id;
    await advance.save();

    // Create BankTransaction when paid from a specific bank account
    if (advance.bankAccountId) {
      try {
        const bankAccount = await BankAccount.findById(advance.bankAccountId);
        if (bankAccount) {
          await bankAccount.addTransaction({
            type: 'withdrawal',
            amount: advance.amount,
            description: `Employee advance issued: ${advance.referenceNo}`,
            date: advance.issueDate || new Date(),
            referenceNumber: advance.referenceNo,
            referenceType: 'EmployeeAdvance',
            reference: advance._id,
            createdBy: userId,
            notes: `Employee advance — ${advance.description}`,
            journalEntryId: journalEntry._id,
          });
        }
      } catch (btErr) {
        console.error('BankTransaction creation failed for employee advance issue:', btErr.message);
      }
    }

    return advance;
  }

  static async recordRepayment(companyId, userId, advanceId, data) {
    const advance = await EmployeeAdvance.findOne({
      _id: advanceId,
      company: companyId
    });

    if (!advance) throw new Error('ADVANCE_NOT_FOUND');
    if (advance.status === 'fully_repaid') throw new Error('ADVANCE_ALREADY_REPAID');

    const repaymentAmount = Math.min(data.amount, advance.balance);
    if (repaymentAmount <= 0) throw new Error('REPAYMENT_AMOUNT_INVALID');

    const repayment = {
      amount: repaymentAmount,
      date: data.date || new Date(),
      paymentMethod: data.paymentMethod || 'cash',
      bankAccountId: data.bankAccountId || null,
      notes: data.notes || '',
      createdBy: userId,
      createdAt: new Date()
    };

    advance.repayments.push(repayment);
    await advance.save();

    // Post journal entry for repayment
    const journalEntry = await this._postRepaymentJournal(companyId, userId, advance, repayment);

    // Update the last repayment with journal entry ID
    const lastRepayment = advance.repayments[advance.repayments.length - 1];
    lastRepayment.journalEntryId = journalEntry._id;
    await advance.save();

    // Create BankTransaction when repaid into a specific bank account
    if (repayment.bankAccountId && repayment.paymentMethod !== 'payroll_deduction') {
      try {
        const bankAccount = await BankAccount.findById(repayment.bankAccountId);
        if (bankAccount) {
          await bankAccount.addTransaction({
            type: 'deposit',
            amount: repayment.amount,
            description: `Employee advance repayment: ${advance.referenceNo}`,
            date: repayment.date || new Date(),
            referenceNumber: advance.referenceNo,
            referenceType: 'EmployeeAdvance',
            reference: advance._id,
            createdBy: userId,
            notes: `Employee advance repayment — ${advance.description}`,
            journalEntryId: journalEntry._id,
          });
        }
      } catch (btErr) {
        console.error('BankTransaction creation failed for employee advance repayment:', btErr.message);
      }
    }

    return advance;
  }

  static async settleAdvance(companyId, userId, advanceId, data) {
    const advance = await EmployeeAdvance.findOne({ _id: advanceId, company: companyId });

    if (!advance) throw new Error('ADVANCE_NOT_FOUND');
    if (advance.status === 'fully_repaid') throw new Error('ADVANCE_ALREADY_REPAID');

    const { expenseAmount = 0, expenseAccountCode = DEFAULT_ACCOUNTS.travelLocalTransport, expenseDescription = '', refundAmount = 0, refundMethod = 'cash', refundBankAccountId = null, notes = '' } = data;

    const totalSettlement = parseFloat(expenseAmount) + parseFloat(refundAmount);
    if (Math.abs(totalSettlement - advance.balance) > 0.01) {
      throw new Error(`SETTLEMENT_AMOUNT_MISMATCH: expense (${expenseAmount}) + refund (${refundAmount}) must equal balance (${advance.balance})`);
    }
    if (totalSettlement <= 0) throw new Error('SETTLEMENT_AMOUNT_INVALID');

    // Determine cash account for refund portion
    let cashAccount = DEFAULT_ACCOUNTS.cashInHand;
    if (refundMethod === 'bank_transfer' || refundMethod === 'cheque') {
      if (refundBankAccountId) {
        const bank = await BankAccount.findById(refundBankAccountId).lean();
        if (bank && bank.ledgerAccountId) cashAccount = bank.ledgerAccountId;
        else cashAccount = DEFAULT_ACCOUNTS.cashAtBank;
      } else {
        cashAccount = DEFAULT_ACCOUNTS.cashAtBank;
      }
    } else if (refundMethod === 'mobile_money') {
      if (refundBankAccountId) {
        const bank = await BankAccount.findById(refundBankAccountId).lean();
        if (bank && bank.ledgerAccountId) cashAccount = bank.ledgerAccountId;
        else cashAccount = DEFAULT_ACCOUNTS.mtnMoMo;
      } else {
        cashAccount = DEFAULT_ACCOUNTS.mtnMoMo;
      }
    } else if (refundMethod === 'petty_cash') {
      cashAccount = DEFAULT_ACCOUNTS.pettyCash;
    }

    const lines = [];

    // Dr Expense (if any)
    if (parseFloat(expenseAmount) > 0) {
      lines.push(JournalService.createDebitLine(
        expenseAccountCode,
        parseFloat(expenseAmount),
        `Advance settlement - ${advance.referenceNo}${expenseDescription ? ': ' + expenseDescription : ''}`
      ));
    }

    // Dr Cash/Bank/Petty Cash (if any refund)
    if (parseFloat(refundAmount) > 0) {
      lines.push(JournalService.createDebitLine(
        cashAccount,
        parseFloat(refundAmount),
        `Advance settlement refund - ${advance.referenceNo}`
      ));
    }

    // Cr Employee Advances (full balance)
    lines.push(JournalService.createCreditLine(
      DEFAULT_ACCOUNTS.employeeAdvances,
      advance.balance,
      `Advance settlement - ${advance.referenceNo}`
    ));

    const journalEntry = await JournalService.createEntry(companyId, userId, {
      date: data.date || new Date(),
      description: `Advance Settlement - ${advance.referenceNo}`,
      sourceType: 'employee_advance_settlement',
      sourceId: advance._id,
      sourceReference: advance.referenceNo,
      lines,
      isAutoGenerated: true
    });

    // Add a special settlement repayment record
    const settlementRepayment = {
      amount: advance.balance,
      date: data.date || new Date(),
      paymentMethod: 'settlement',
      bankAccountId: null,
      notes: notes || `Settlement: expense ${expenseAmount} + refund ${refundAmount}`,
      createdBy: userId,
      createdAt: new Date(),
      journalEntryId: journalEntry._id
    };

    advance.repayments.push(settlementRepayment);
    await advance.save();

    return advance;
  }

  static async getById(companyId, advanceId) {
    return EmployeeAdvance.findOne({ _id: advanceId, company: companyId })
      .populate('employee', 'firstName lastName employeeId email')
      .populate('journalEntryId', 'entryNumber date status')
      .populate('repayments.journalEntryId', 'entryNumber date status');
  }

  static async getAll(companyId, filters = {}) {
    const query = { company: companyId };

    if (filters.status) query.status = filters.status;
    if (filters.employeeId) query.employee = new mongoose.Types.ObjectId(filters.employeeId);
    if (filters.startDate || filters.endDate) {
      query.issueDate = {};
      if (filters.startDate) query.issueDate.$gte = new Date(filters.startDate);
      if (filters.endDate) query.issueDate.$lte = new Date(filters.endDate);
    }

    const page = parseInt(filters.page) || 1;
    const limit = parseInt(filters.limit) || 50;
    const skip = (page - 1) * limit;

    const [advances, total] = await Promise.all([
      EmployeeAdvance.find(query)
        .populate('employee', 'firstName lastName employeeId email')
        .sort({ issueDate: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      EmployeeAdvance.countDocuments(query)
    ]);

    return { advances, total, page, limit, totalPages: Math.ceil(total / limit) };
  }

  static async getEmployeeBalance(companyId, employeeId) {
    const result = await dbClient().employeeAdvance.aggregate({
      where: {
        companyId: String(companyId),
        employeeId: String(employeeId),
        status: { in: ['issued', 'partially_repaid'] },
      },
      _sum: { amount: true, amountRepaid: true, balance: true },
    });

    return {
      totalIssued: Number(result._sum?.amount || 0),
      totalRepaid: Number(result._sum?.amountRepaid || 0),
      totalBalance: Number(result._sum?.balance || 0),
    };
  }

  static async delete(companyId, advanceId) {
    const advance = await EmployeeAdvance.findOne({ _id: advanceId, company: companyId });
    if (!advance) throw new Error('ADVANCE_NOT_FOUND');
    if (advance.status !== 'issued') throw new Error('CANNOT_DELETE_REPAID_ADVANCE');

    await EmployeeAdvance.deleteOne({ _id: advanceId, company: companyId });
    return { deleted: true };
  }

  // ── Private: Journal Entry Helpers ──────────────────────────────────

  static async _postIssueJournal(companyId, userId, advance) {
    const lines = [];

    // Determine cash account
    let cashAccount = DEFAULT_ACCOUNTS.cashInHand;
    if (advance.paymentMethod === 'bank_transfer' || advance.paymentMethod === 'cheque') {
      if (advance.bankAccountId) {
        const bank = await BankAccount.findById(advance.bankAccountId).lean();
        if (bank && bank.ledgerAccountId) cashAccount = bank.ledgerAccountId;
        else cashAccount = DEFAULT_ACCOUNTS.cashAtBank;
      } else {
        cashAccount = DEFAULT_ACCOUNTS.cashAtBank;
      }
    } else if (advance.paymentMethod === 'mobile_money') {
      if (advance.bankAccountId) {
        const bank = await BankAccount.findById(advance.bankAccountId).lean();
        if (bank && bank.ledgerAccountId) cashAccount = bank.ledgerAccountId;
        else cashAccount = DEFAULT_ACCOUNTS.mtnMoMo;
      } else {
        cashAccount = DEFAULT_ACCOUNTS.mtnMoMo;
      }
    }

    // Dr Employee Advances
    lines.push(JournalService.createDebitLine(
      DEFAULT_ACCOUNTS.employeeAdvances,
      advance.amount,
      `Employee advance issued - ${advance.referenceNo}`
    ));

    // Cr Cash/Bank/MoMo
    lines.push(JournalService.createCreditLine(
      cashAccount,
      advance.amount,
      `Employee advance issued - ${advance.referenceNo}`
    ));

    return JournalService.createEntry(companyId, userId, {
      date: advance.issueDate || new Date(),
      description: `Employee Advance Issued - ${advance.referenceNo}`,
      sourceType: 'employee_advance',
      sourceId: advance._id,
      sourceReference: advance.referenceNo,
      lines,
      isAutoGenerated: true
    });
  }

  static async _postRepaymentJournal(companyId, userId, advance, repayment) {
    const lines = [];

    // Determine cash account for repayment
    let cashAccount = DEFAULT_ACCOUNTS.cashInHand;
    if (repayment.paymentMethod === 'bank_transfer' || repayment.paymentMethod === 'cheque') {
      if (repayment.bankAccountId) {
        const bank = await BankAccount.findById(repayment.bankAccountId).lean();
        if (bank && bank.ledgerAccountId) cashAccount = bank.ledgerAccountId;
        else cashAccount = DEFAULT_ACCOUNTS.cashAtBank;
      } else {
        cashAccount = DEFAULT_ACCOUNTS.cashAtBank;
      }
    } else if (repayment.paymentMethod === 'mobile_money') {
      if (repayment.bankAccountId) {
        const bank = await BankAccount.findById(repayment.bankAccountId).lean();
        if (bank && bank.ledgerAccountId) cashAccount = bank.ledgerAccountId;
        else cashAccount = DEFAULT_ACCOUNTS.mtnMoMo;
      } else {
        cashAccount = DEFAULT_ACCOUNTS.mtnMoMo;
      }
    } else if (repayment.paymentMethod === 'payroll_deduction') {
      // Payroll deduction: Dr Salaries / Cr Employee Advances
      cashAccount = DEFAULT_ACCOUNTS.salaries;
    }

    if (repayment.paymentMethod === 'payroll_deduction') {
      // Dr Salaries (expense increases because employee net pay is reduced)
      lines.push(JournalService.createDebitLine(
        DEFAULT_ACCOUNTS.salaries,
        repayment.amount,
        `Payroll deduction for advance ${advance.referenceNo}`
      ));
    } else {
      // Dr Cash/Bank/MoMo
      lines.push(JournalService.createDebitLine(
        cashAccount,
        repayment.amount,
        `Employee advance repayment - ${advance.referenceNo}`
      ));
    }

    // Cr Employee Advances
    lines.push(JournalService.createCreditLine(
      DEFAULT_ACCOUNTS.employeeAdvances,
      repayment.amount,
      `Employee advance repayment - ${advance.referenceNo}`
    ));

    return JournalService.createEntry(companyId, userId, {
      date: repayment.date || new Date(),
      description: `Employee Advance Repayment - ${advance.referenceNo}`,
      sourceType: 'employee_advance_repayment',
      sourceId: advance._id,
      sourceReference: advance.referenceNo,
      lines,
      isAutoGenerated: true
    });
  }
}

module.exports = EmployeeAdvanceService;
