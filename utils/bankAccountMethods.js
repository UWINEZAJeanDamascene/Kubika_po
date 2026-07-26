/**
 * BankAccount static/instance methods ported from the legacy Mongoose model.
 */

const { prisma } = require('../lib/prisma');
const { decimalToNumber } = require('./decimalHelpers');
const { queryWithTimeout } = require('./sqlQuery');
const {
  bankAccountToApi,
  bankAccountTranslateCreate,
  bankAccountTranslateUpdate,
  bankTransactionToApi,
  bankTransactionTranslateCreate,
  bankTransactionTranslateUpdate,
} = require('./bankingMappers');

const IN_TYPES = ['deposit', 'transfer_in', 'opening', 'debit'];
const OUT_TYPES = ['withdrawal', 'transfer_out', 'closing', 'credit'];

let bankTransactionRef = null;

function setBankTransactionRef(ref) {
  bankTransactionRef = ref;
}

const BankAccountDocProto = {};

BankAccountDocProto.addTransaction = async function addTransaction(transactionData) {
  const BankTransaction = bankTransactionRef;
  if (!BankTransaction) throw new Error('BankTransaction model is not initialized');

  if (transactionData.journalEntryId) {
    const duplicate = await BankTransaction.findOne({
      $and: [
        { $or: [{ companyId: this.companyId || this.company }, { company: this.companyId || this.company }] },
        { $or: [{ bankAccountId: this._id }, { account: this._id }] },
      ],
      journalEntryId: transactionData.journalEntryId,
      amount: Number(transactionData.amount || 0),
    });
    if (duplicate) return duplicate;
  }

  const currentBal = decimalToNumber(this.cachedBalance, 0);
  let newBal = currentBal;
  const txType = transactionData.type;
  if (txType === 'deposit' || txType === 'transfer_in' || txType === 'opening' || txType === 'debit') {
    newBal += Number(transactionData.amount || 0);
  } else if (txType === 'withdrawal' || txType === 'transfer_out' || txType === 'closing' || txType === 'credit') {
    newBal -= Number(transactionData.amount || 0);
  } else if (txType === 'adjustment') {
    newBal = transactionData.balanceAfter !== undefined ? transactionData.balanceAfter : currentBal;
  }

  const tx = await BankTransaction.create({
    ...transactionData,
    account: this._id,
    bankAccountId: this._id,
    company: this.company || this.companyId,
    companyId: this.companyId || this.company,
    balanceAfter: newBal,
    balance: newBal,
  });

  await prisma.bankAccount.update({
    where: { id: String(this._id) },
    data: {
      cachedBalance: String(newBal),
      cacheValid: false,
      cacheLastComputed: null,
    },
  });

  this.cachedBalance = newBal;
  this.cacheValid = false;
  this.cacheLastComputed = null;
  return tx;
};

BankAccountDocProto.getBalance = async function getBalance(_JournalEntry, asOfDate) {
  if (this.cacheValid) {
    return {
      balance: decimalToNumber(this.cachedBalance, 0),
      cached: true,
      computedAt: this.cacheLastComputed,
    };
  }

  const companyId = String(this.company || this.companyId);
  const ledgerAccountId = this.ledgerAccountId || '1100';
  const openingBalance = decimalToNumber(this.openingBalance, 0);
  const openingBalanceDate = this.openingBalanceDate || new Date(0);

  const params = [companyId, openingBalanceDate, ledgerAccountId];
  let dateClause = 'AND je.date >= $2';
  if (asOfDate) {
    params.push(new Date(asOfDate));
    dateClause += ' AND je.date <= $4';
  }

  const rows = await queryWithTimeout(
    `SELECT
       COALESCE(SUM(jel.debit), 0)::float AS total_debits,
       COALESCE(SUM(jel.credit), 0)::float AS total_credits,
       COUNT(*)::int AS journal_count
     FROM journal_entry_lines jel
     INNER JOIN journal_entries je ON je.id = jel.journal_entry_id
     WHERE je.company_id = $1
       AND je.status = 'posted'
       ${dateClause}
       AND jel.account_code = $3`,
    params,
    'report',
  );

  const agg = rows[0] || {};
  const totalDebits = Number(agg.total_debits || 0);
  const totalCredits = Number(agg.total_credits || 0);
  const journalEntryCount = Number(agg.journal_count || 0);
  const computedBalance = totalDebits - totalCredits;
  const now = new Date();

  await prisma.bankAccount.update({
    where: { id: String(this._id) },
    data: {
      cachedBalance: String(computedBalance),
      cacheValid: true,
      cacheLastComputed: now,
    },
  });

  this.cachedBalance = computedBalance;
  this.cacheValid = true;
  this.cacheLastComputed = now;

  return {
    balance: computedBalance,
    cached: false,
    computedAt: now,
    details: {
      openingBalance,
      totalDebits,
      totalCredits,
      journalEntryCount,
    },
  };
};

BankAccountDocProto.save = async function save() {
  if (this.isNew || !this._id) {
    const createData = await bankAccountTranslateCreate(this);
    if (createData.isDefault) {
      await prisma.bankAccount.updateMany({
        where: { companyId: createData.companyId, id: { not: createData.id } },
        data: { isDefault: false },
      });
    }
    const row = await prisma.bankAccount.create({ data: createData });
    Object.assign(this, bankAccountToApi(row));
    this.isNew = false;
    this.__mutable = true;
    return this;
  }

  if (this.isDefault) {
    await prisma.bankAccount.updateMany({
      where: {
        companyId: String(this.company || this.companyId),
        id: { not: String(this._id) },
      },
      data: { isDefault: false },
    });
  }

  const row = await prisma.bankAccount.update({
    where: { id: String(this._id) },
    data: bankAccountTranslateUpdate({ $set: this }),
  });
  Object.assign(this, bankAccountToApi(row));
  this.__mutable = true;
  return this;
};

function wrapBankAccountDoc(apiDoc) {
  if (!apiDoc) return null;
  if (apiDoc.__mutable && apiDoc.save) return apiDoc;

  const doc = Object.create(BankAccountDocProto);
  Object.assign(doc, apiDoc, { __mutable: true });

  doc.toObject = () => {
    const o = { ...doc };
    ['save', 'toObject', 'toJSON', 'lean', '__mutable', 'addTransaction', 'getBalance', 'isNew'].forEach((k) => delete o[k]);
    return o;
  };
  doc.lean = () => doc.toObject();
  doc.toJSON = () => doc.toObject();

  return doc;
}

function attachBankAccountStatics(BankAccount) {
  BankAccount.getTotalCashPosition = async function getTotalCashPosition(companyId) {
    const accounts = await BankAccount.find({ company: companyId, isActive: true });
    const result = {
      total: 0,
      byType: {
        bk_bank: 0,
        equity_bank: 0,
        im_bank: 0,
        cogebanque: 0,
        ecobank: 0,
        mtn_momo: 0,
        airtel_money: 0,
        cash_in_hand: 0,
      },
      accounts: [],
    };

    for (const account of accounts) {
      const balance = decimalToNumber(account.cachedBalance, 0);
      result.total += balance;
      if (result.byType[account.accountType] != null) {
        result.byType[account.accountType] += balance;
      }
      result.accounts.push({
        _id: account._id,
        name: account.name,
        accountType: account.accountType,
        balance,
        cacheValid: account.cacheValid,
      });
    }

    return result;
  };

  BankAccount.invalidateCacheForLedgerAccount = async function invalidateCacheForLedgerAccount(
    companyId,
    ledgerAccountId,
  ) {
    return BankAccount.updateMany(
      { company: companyId, ledgerAccountId },
      { $set: { cacheValid: false } },
    );
  };

  BankAccount.getByType = async function getByType(companyId, accountType) {
    return BankAccount.find({ company: companyId, accountType, isActive: true });
  };

  BankAccount.getDefault = async function getDefault(companyId) {
    return BankAccount.findOne({ company: companyId, isDefault: true, isActive: true });
  };

  BankAccount.computeBalanceFromTransactions = async function computeBalanceFromTransactions(
    accountId,
    openingBalance,
  ) {
    const bankAccountId = String(accountId);
    const latest = await prisma.bankTransaction.findFirst({
      where: { bankAccountId },
      orderBy: [{ date: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
      select: { balanceAfter: true, balance: true },
    });

    if (latest) {
      return decimalToNumber(latest.balanceAfter ?? latest.balance, 0);
    }

    const rows = await prisma.bankTransaction.groupBy({
      by: ['type'],
      where: { bankAccountId },
      _sum: { amount: true },
    });

    let totalIn = 0;
    let totalOut = 0;
    for (const row of rows) {
      const sum = decimalToNumber(row._sum.amount, 0);
      if (IN_TYPES.includes(row.type)) totalIn += sum;
      if (OUT_TYPES.includes(row.type)) totalOut += sum;
    }

    const ob = decimalToNumber(openingBalance, 0);
    const hasOpeningTx = rows.some((row) => row.type === 'opening');
    if (hasOpeningTx) {
      return totalIn - totalOut;
    }

    return ob + totalIn - totalOut;
  };
}

function buildConstructorModel({
  name,
  baseModel,
  toApi,
  translateCreate,
  translateUpdate,
  wrapDoc,
  delegateName,
}) {
  function Doc(data = {}) {
    Object.assign(this, data);
    this.isNew = !this._id;
  }

  Doc.prototype.save = async function save() {
    const delegate = () => prisma[delegateName];
    if (this.isNew || !this._id) {
      const createData = await translateCreate(this);
      const row = await delegate().create({ data: createData });
      const next = wrapDoc ? wrapDoc(toApi(row)) : toApi(row);
      Object.assign(this, next);
      this.isNew = false;
      return this;
    }
    const payload = translateUpdate({ $set: this });
    const row = await delegate().update({
      where: { id: String(this._id) },
      data: payload,
    });
    const next = wrapDoc ? wrapDoc(toApi(row)) : toApi(row);
    Object.keys(this).forEach((k) => { if (k !== 'save') delete this[k]; });
    Object.assign(this, next);
    return this;
  };

  function Model(data) {
    if (!(this instanceof Model)) return new Doc(data);
    return Doc.call(this, data);
  }

  Object.assign(Model, baseModel);
  Model.prototype = Doc.prototype;
  Model.modelName = name;

  Model.create = async function create(data) {
    const doc = new Doc(data);
    return doc.save();
  };

  return Model;
}

function buildBankTransactionModel(base) {
  function Doc(data = {}) {
    Object.assign(this, data);
    this.isNew = !this._id;
  }

  Doc.prototype.save = async function save() {
    if (this.isNew || !this._id) {
      const createData = await bankTransactionTranslateCreate(this);
      const row = await prisma.bankTransaction.create({ data: createData });
      Object.assign(this, bankTransactionToApi(row));
      this.isNew = false;
      return this;
    }
    const row = await prisma.bankTransaction.update({
      where: { id: String(this._id) },
      data: bankTransactionTranslateUpdate({ $set: this }),
    });
    Object.assign(this, bankTransactionToApi(row));
    return this;
  };

  function BankTransaction(data) {
    if (!(this instanceof BankTransaction)) return new Doc(data);
    return Doc.call(this, data);
  }

  Object.assign(BankTransaction, base);
  BankTransaction.prototype = Doc.prototype;
  BankTransaction.modelName = 'BankTransaction';
  BankTransaction.create = async (data) => {
    const doc = new Doc(data);
    return doc.save();
  };

  return BankTransaction;
}

module.exports = {
  setBankTransactionRef,
  attachBankAccountStatics,
  wrapBankAccountDoc,
  buildConstructorModel,
  buildBankTransactionModel,
  BankAccountDocProto,
};
