/**
 * POS E2E pack — checkout contracts for the canonical sales-legacy path.
 * Controllers are exercised with boundary mocks (no live DB required).
 */

jest.mock('../models/Invoice', () => ({ findOne: jest.fn(), create: jest.fn() }));
jest.mock('../models/Client', () => ({ findOne: jest.fn(), create: jest.fn() }));
jest.mock('../models/Product', () => ({ find: jest.fn(), bulkWrite: jest.fn() }));
jest.mock('../models/StockMovement', () => ({ insertMany: jest.fn() }));
jest.mock('../models/Warehouse', () => ({ findOne: jest.fn() }));
jest.mock('../models/Company', () => ({ findById: jest.fn() }));
jest.mock('../models/BankAccount', () => ({ BankAccount: { findOne: jest.fn(), invalidateCacheForLedgerAccount: jest.fn() } }));
jest.mock('../models/TillSession', () => ({ findOne: jest.fn() }));
jest.mock('../models/StockLevel', () => ({ find: jest.fn(), updateMany: jest.fn() }));
jest.mock('../models/StockSerialNumber', () => ({ find: jest.fn(), updateMany: jest.fn() }));
jest.mock('../models/StockBatch', () => ({ find: jest.fn() }));
jest.mock('../models/InventoryBatch', () => ({ find: jest.fn() }));
jest.mock('../services/transactionService', () => ({ runInTransaction: jest.fn() }));
jest.mock('../services/inventoryService', () => ({ consume: jest.fn(), reduceLayers: jest.fn() }));
jest.mock('../services/journalService', () => ({
  getMappedAccountCode: jest.fn(),
  createDebitLine: jest.fn((account, amount, desc) => ({ accountCode: account, debit: amount, credit: 0, description: desc })),
  createCreditLine: jest.fn((account, amount, desc) => ({ accountCode: account, debit: 0, credit: amount, description: desc })),
  createEntriesAtomic: jest.fn(),
}));
jest.mock('../services/CurrencyService', () => ({ getCompanyBase: jest.fn() }));
jest.mock('../services/cacheService', () => ({ bumpCompanyFinancialCaches: jest.fn() }));
jest.mock('../services/emailService', () => ({ sendInvoiceEmail: jest.fn() }));
jest.mock('../services/ebmService', () => ({ getConfig: jest.fn(() => ({ mode: 'mock' })) }));
jest.mock('../services/ebmSalesService', () => ({ submitInvoiceAsync: jest.fn() }));
jest.mock('../controllers/posManagerApprovalController', () => ({
  consumeApproval: jest.fn(),
  hashPayload: jest.fn((payload) => JSON.stringify(payload || {})),
}));
jest.mock('../controllers/posController', () => ({ getReceipt: jest.fn() }));
jest.mock('../lib/prisma', () => ({
  dbClient: jest.fn(),
  prisma: {},
}));

const Invoice = require('../models/Invoice');
const Client = require('../models/Client');
const Product = require('../models/Product');
const StockMovement = require('../models/StockMovement');
const Warehouse = require('../models/Warehouse');
const { BankAccount } = require('../models/BankAccount');
const TillSession = require('../models/TillSession');
const StockLevel = require('../models/StockLevel');
const { runInTransaction } = require('../services/transactionService');
const inventoryService = require('../services/inventoryService');
const JournalService = require('../services/journalService');
const CurrencyService = require('../services/CurrencyService');
const cacheService = require('../services/cacheService');
const { consumeApproval } = require('../controllers/posManagerApprovalController');
const { dbClient } = require('../lib/prisma');
const { createDirectSale } = require('../controllers/salesLegacyController');
const {
  IDS,
  mockRes,
  catalogProduct,
  checkoutBody,
  makeReq,
  saleLine,
} = require('./helpers/posE2eFixtures');

function leanFind(value) {
  return { select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue(value) }) };
}

function stockLevelRows(qtyOnHand = 50, qtyReserved = 0) {
  return [{
    product_id: IDS.product,
    qty_on_hand: qtyOnHand,
    qty_reserved: qtyReserved,
  }];
}

function buildInvoiceDoc(overrides = {}) {
  const invoice = {
    _id: IDS.invoice,
    referenceNo: 'INV-POS-1',
    grandTotal: 1180,
    totalAmount: 1180,
    payments: [],
    save: jest.fn().mockResolvedValue(undefined),
    populate: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  };
  invoice.populate.mockResolvedValue(invoice);
  return invoice;
}

function stubHappyPathDeps({ stockMatchedCount = 1, momoBank = null } = {}) {
  CurrencyService.getCompanyBase.mockResolvedValue('RWF');
  TillSession.findOne.mockResolvedValue({ _id: IDS.till, status: 'open', openedBy: IDS.cashier });
  Warehouse.findOne.mockResolvedValue({ _id: IDS.warehouse });
  Product.find.mockReturnValue(leanFind([catalogProduct()]));
  StockLevel.find.mockReturnValue({ lean: jest.fn().mockResolvedValue(stockLevelRows()) });
  StockLevel.updateMany.mockResolvedValue({ matchedCount: stockMatchedCount });
  Client.findOne.mockResolvedValue(null);
  Client.create.mockResolvedValue({
    _id: IDS.client,
    name: 'Walk-in Customer',
    totalPurchases: 0,
    outstandingBalance: 0,
    save: jest.fn().mockResolvedValue(undefined),
  });
  const invoice = buildInvoiceDoc();
  Invoice.create.mockResolvedValue([invoice]);
  inventoryService.consume.mockResolvedValue({
    allocations: [{ qty: 1, unitCost: 400, amount: 400 }],
    totalCost: 400,
  });
  Product.bulkWrite.mockResolvedValue({});
  StockMovement.insertMany.mockResolvedValue([]);
  JournalService.getMappedAccountCode.mockImplementation(async (_c, _m, _k, fallback) => fallback);
  JournalService.createEntriesAtomic.mockResolvedValue([{ _id: 'je-rev' }, { _id: 'je-cogs' }]);
  BankAccount.findOne.mockReturnValue({
    select: jest.fn().mockReturnValue({
      lean: jest.fn().mockResolvedValue(momoBank),
    }),
  });
  BankAccount.invalidateCacheForLedgerAccount.mockResolvedValue(undefined);
  cacheService.bumpCompanyFinancialCaches.mockResolvedValue(undefined);
  consumeApproval.mockResolvedValue(IDS.approval);

  const db = {
    // SELECT replay → empty; INSERT reservation → claimed row.
    $queryRawUnsafe: jest.fn(async (sql) => {
      if (String(sql).includes('INSERT INTO pos_sale_requests')) {
        return [{ requestKey: 'claimed' }];
      }
      return [];
    }),
    $executeRawUnsafe: jest.fn().mockResolvedValue(1),
  };
  dbClient.mockReturnValue(db);
  runInTransaction.mockImplementation(async (fn) => fn(null));
  return { invoice, db };
}

describe('POS E2E — checkout (sales-legacy)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('rejects checkout when no open till exists for the register', async () => {
    CurrencyService.getCompanyBase.mockResolvedValue('RWF');
    TillSession.findOne.mockResolvedValue(null);
    dbClient.mockReturnValue({ $queryRawUnsafe: jest.fn().mockResolvedValue([]) });
    const res = mockRes();
    await createDirectSale(makeReq({ body: checkoutBody() }), res, jest.fn());
    expect(res.statusCode).toBe(400);
    expect(res.body.message).toMatch(/Till session is required/i);
  });

  test('blocks card tender until a terminal is configured', async () => {
    CurrencyService.getCompanyBase.mockResolvedValue('RWF');
    TillSession.findOne.mockResolvedValue({ _id: IDS.till, status: 'open' });
    Warehouse.findOne.mockResolvedValue({ _id: IDS.warehouse });
    Product.find.mockReturnValue(leanFind([catalogProduct()]));
    StockLevel.find.mockReturnValue({ lean: jest.fn().mockResolvedValue(stockLevelRows()) });
    dbClient.mockReturnValue({ $queryRawUnsafe: jest.fn().mockResolvedValue([]) });

    const res = mockRes();
    await createDirectSale(makeReq({
      body: checkoutBody({ paymentMethod: 'card', paymentAmount: 1180 }),
    }), res, jest.fn());

    expect(res.statusCode).toBe(409);
    expect(res.body.code).toBe('POS_CARD_TERMINAL_NOT_CONFIGURED');
    expect(runInTransaction).not.toHaveBeenCalled();
  });

  test('requires a manager approval for discounts / price overrides', async () => {
    CurrencyService.getCompanyBase.mockResolvedValue('RWF');
    TillSession.findOne.mockResolvedValue({ _id: IDS.till, status: 'open' });
    Warehouse.findOne.mockResolvedValue({ _id: IDS.warehouse });
    Product.find.mockReturnValue(leanFind([catalogProduct()]));
    StockLevel.find.mockReturnValue({ lean: jest.fn().mockResolvedValue(stockLevelRows()) });
    dbClient.mockReturnValue({ $queryRawUnsafe: jest.fn().mockResolvedValue([]) });

    const res = mockRes();
    await createDirectSale(makeReq({
      body: checkoutBody({
        items: [saleLine({ discountPct: 10, unitPrice: 1000 })],
        paymentAmount: 1062,
      }),
    }), res, jest.fn());

    expect(res.statusCode).toBe(403);
    expect(res.body.code).toBe('POS_MANAGER_APPROVAL_REQUIRED');
  });

  test('cash checkout posts stock, journals, and till cash activity', async () => {
    const { invoice, db } = stubHappyPathDeps();
    const res = mockRes();

    await createDirectSale(makeReq({
      body: checkoutBody(),
      headers: { 'Idempotency-Key': 'idem-key-abcdefghij' },
    }), res, (err) => { throw err; });

    expect(res.statusCode).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toBe(invoice);
    expect(res.body.changeDue).toBe(0);
    expect(StockLevel.updateMany).toHaveBeenCalled();
    expect(inventoryService.consume).toHaveBeenCalled();
    expect(JournalService.createEntriesAtomic).toHaveBeenCalled();
    expect(db.$executeRawUnsafe).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE till_sessions SET expected_cash'),
      1180,
      expect.any(String),
      IDS.company,
      IDS.till,
      IDS.cashier,
    );
  });

  test('rejects unpaid walk-in sales before creating a customer or invoice', async () => {
    stubHappyPathDeps();
    const res = mockRes();

    await createDirectSale(makeReq({ body: checkoutBody({ paymentAmount: 500 }) }), res, jest.fn());

    expect(res.statusCode).toBe(409);
    expect(res.body.code).toBe('POS_WALKIN_CREDIT_NOT_ALLOWED');
    expect(Client.create).not.toHaveBeenCalled();
    expect(Invoice.create).not.toHaveBeenCalled();
  });

  test('blocks a registered customer sale that exceeds available credit', async () => {
    const { db } = stubHappyPathDeps();
    Client.findOne.mockResolvedValue({ _id: IDS.client, name: 'Account Customer' });
    db.$queryRawUnsafe.mockImplementation(async (sql) => {
      if (String(sql).includes('SELECT credit_limit')) return [{ credit_limit: '1000', outstanding_balance: '400' }];
      if (String(sql).includes('INSERT INTO pos_sale_requests')) return [{ requestKey: 'claimed' }];
      return [];
    });
    const res = mockRes();

    await createDirectSale(makeReq({
      body: checkoutBody({ clientId: IDS.client, paymentAmount: 500 }),
    }), res, jest.fn());

    expect(res.statusCode).toBe(409);
    expect(res.body.code).toBe('POS_CREDIT_LIMIT_EXCEEDED');
    expect(Invoice.create).not.toHaveBeenCalled();
  });

  test('allows partial payment within available customer credit and saves the locked balance', async () => {
    const { db } = stubHappyPathDeps();
    const client = {
      _id: IDS.client,
      name: 'Account Customer',
      totalPurchases: 0,
      outstandingBalance: 0,
      save: jest.fn().mockResolvedValue(undefined),
    };
    Client.findOne.mockResolvedValue(client);
    db.$queryRawUnsafe.mockImplementation(async (sql) => {
      if (String(sql).includes('SELECT credit_limit')) return [{ credit_limit: '1000', outstanding_balance: '100' }];
      if (String(sql).includes('INSERT INTO pos_sale_requests')) return [{ requestKey: 'claimed' }];
      return [];
    });
    const res = mockRes();

    await createDirectSale(makeReq({
      body: checkoutBody({ clientId: IDS.client, paymentAmount: 500 }),
    }), res, (err) => { throw err; });

    expect(res.statusCode).toBe(201);
    expect(client.outstandingBalance).toBe(780);
    expect(client.save).toHaveBeenCalled();
  });

  test('mobile money checkout requires a payment reference and bank account', async () => {
    CurrencyService.getCompanyBase.mockResolvedValue('RWF');
    TillSession.findOne.mockResolvedValue({ _id: IDS.till, status: 'open' });
    Warehouse.findOne.mockResolvedValue({ _id: IDS.warehouse });
    Product.find.mockReturnValue(leanFind([catalogProduct()]));
    StockLevel.find.mockReturnValue({ lean: jest.fn().mockResolvedValue(stockLevelRows()) });
    dbClient.mockReturnValue({ $queryRawUnsafe: jest.fn().mockResolvedValue([]) });

    const missingRef = mockRes();
    await createDirectSale(makeReq({
      body: checkoutBody({
        paymentMethod: 'mobile_money',
        paymentAmount: 1180,
        paymentReference: '',
        bankAccountId: IDS.bank,
      }),
    }), missingRef, jest.fn());
    expect(missingRef.statusCode).toBe(400);
    expect(missingRef.body.code).toBe('POS_PAYMENT_REFERENCE_REQUIRED');

    stubHappyPathDeps({
      momoBank: { _id: IDS.bank, ledgerAccountId: '1200', name: 'MoMo', isActive: true },
    });
    const ok = mockRes();
    await createDirectSale(makeReq({
      body: checkoutBody({
        paymentMethod: 'mobile_money',
        paymentAmount: 1180,
        paymentReference: 'MOMO-TX-99',
        bankAccountId: IDS.bank,
      }),
      headers: { 'Idempotency-Key': 'momo-key-abcdefghij' },
    }), ok, (err) => { throw err; });

    expect(ok.statusCode).toBe(201);
    expect(BankAccount.findOne).toHaveBeenCalledWith(expect.objectContaining({
      _id: IDS.bank,
      company: IDS.company,
      isActive: true,
    }));
  });

  test('discounted checkout consumes the one-use manager approval', async () => {
    stubHappyPathDeps();
    const res = mockRes();
    await createDirectSale(makeReq({
      body: checkoutBody({
        items: [saleLine({ discountPct: 5 })],
        paymentAmount: 1121,
        managerApprovalId: IDS.approval,
      }),
      headers: { 'Idempotency-Key': 'disc-key-abcdefghij' },
    }), res, (err) => { throw err; });

    expect(res.statusCode).toBe(201);
    expect(consumeApproval).toHaveBeenCalledWith(expect.objectContaining({
      approvalId: IDS.approval,
      companyId: IDS.company,
      cashierId: IDS.cashier,
      action: 'discount',
    }));
  });

  test('stock race returns conflict when warehouse qty changes mid-checkout', async () => {
    stubHappyPathDeps({ stockMatchedCount: 0 });
    const res = mockRes();
    await createDirectSale(makeReq({
      body: checkoutBody(),
      headers: { 'Idempotency-Key': 'race-key-abcdefghij' },
    }), res, jest.fn());

    expect(res.statusCode).toBe(409);
    expect(res.body.code).toBe('ERR_INSUFFICIENT_STOCK');
    expect(res.body.message).toMatch(/Stock at the selected warehouse changed/i);
    expect(StockLevel.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        company_id: IDS.company,
        product_id: IDS.product,
        warehouse_id: IDS.warehouse,
        qty_reserved: 0,
        qty_on_hand: { $gte: expect.any(Number) },
      }),
      expect.objectContaining({ $inc: { qty_on_hand: expect.any(Number) } }),
    );
  });

  test('idempotent retry replays the completed invoice instead of double-selling', async () => {
    CurrencyService.getCompanyBase.mockResolvedValue('RWF');
    const body = checkoutBody();
    const payloadHash = require('crypto').createHash('sha256').update(JSON.stringify(body)).digest('hex');
    const priorInvoice = buildInvoiceDoc({
      grandTotal: 1180,
      client: IDS.client,
    });
    dbClient.mockReturnValue({
      $queryRawUnsafe: jest.fn().mockResolvedValue([{
        requestKey: 'retry-key-abcdefghij',
        createdById: IDS.cashier,
        payloadHash,
        invoiceId: IDS.invoice,
        status: 'completed',
      }]),
    });
    Invoice.findOne.mockReturnValue({
      populate: jest.fn().mockResolvedValue(priorInvoice),
    });

    const res = mockRes();
    await createDirectSale(makeReq({
      body,
      headers: { 'Idempotency-Key': 'retry-key-abcdefghij' },
    }), res, jest.fn());

    expect(res.statusCode).toBe(200);
    expect(res.body.replayed).toBe(true);
    expect(res.body.data).toBe(priorInvoice);
    expect(runInTransaction).not.toHaveBeenCalled();
  });

  test('concurrent requests with the same idempotency key reserve only one sale', async () => {
    const { invoice, db } = stubHappyPathDeps();
    let finishInitialReads;
    const bothInitialReads = new Promise((resolve) => { finishInitialReads = resolve; });
    let initialReadCount = 0;
    let reserved = false;
    let reservation;
    db.$queryRawUnsafe.mockImplementation(async (sql, ...values) => {
      if (String(sql).includes('SELECT request_key AS')) {
        initialReadCount += 1;
        if (initialReadCount === 2) finishInitialReads();
        await bothInitialReads;
        return reserved ? [{ ...reservation, status: 'processing' }] : [];
      }
      if (String(sql).includes('INSERT INTO pos_sale_requests')) {
        if (reserved) return [];
        reserved = true;
        reservation = { requestKey: values[1], createdById: values[2], payloadHash: values[3] };
        return [{ requestKey: values[1] }];
      }
      return [];
    });

    const request = () => makeReq({
      body: checkoutBody(),
      headers: { 'Idempotency-Key': 'concurrent-key-12345' },
    });
    const firstResponse = mockRes();
    const secondResponse = mockRes();
    const next = (error) => { if (error) throw error; };

    await Promise.all([
      createDirectSale(request(), firstResponse, next),
      createDirectSale(request(), secondResponse, next),
    ]);

    expect([firstResponse.statusCode, secondResponse.statusCode].sort()).toEqual([201, 409]);
    expect([firstResponse, secondResponse].find((response) => response.statusCode === 409).body.code)
      .toBe('POS_SALE_STILL_PROCESSING');
    expect(Invoice.create).toHaveBeenCalledTimes(1);
    expect(inventoryService.consume).toHaveBeenCalledTimes(1);
    expect(Product.bulkWrite).toHaveBeenCalledTimes(1);
    expect(firstResponse.body.data === invoice || secondResponse.body.data === invoice).toBe(true);
  });

  test('idempotency key conflict rejects a different payload on the same key', async () => {
    CurrencyService.getCompanyBase.mockResolvedValue('RWF');
    dbClient.mockReturnValue({
      $queryRawUnsafe: jest.fn().mockResolvedValue([{
        requestKey: 'conflict-key-abcdef',
        createdById: IDS.cashier,
        payloadHash: 'different-hash',
        invoiceId: IDS.invoice,
        status: 'completed',
      }]),
    });

    const res = mockRes();
    await createDirectSale(makeReq({
      body: checkoutBody(),
      headers: { 'Idempotency-Key': 'conflict-key-abcdef' },
    }), res, jest.fn());

    expect(res.statusCode).toBe(409);
    expect(res.body.code).toBe('POS_IDEMPOTENCY_KEY_CONFLICT');
  });

  test('preflight rejects when available warehouse stock is insufficient', async () => {
    CurrencyService.getCompanyBase.mockResolvedValue('RWF');
    TillSession.findOne.mockResolvedValue({ _id: IDS.till, status: 'open' });
    Warehouse.findOne.mockResolvedValue({ _id: IDS.warehouse });
    Product.find.mockReturnValue(leanFind([catalogProduct()]));
    StockLevel.find.mockReturnValue({ lean: jest.fn().mockResolvedValue(stockLevelRows(0, 0)) });
    dbClient.mockReturnValue({ $queryRawUnsafe: jest.fn().mockResolvedValue([]) });

    const res = mockRes();
    await createDirectSale(makeReq({ body: checkoutBody() }), res, jest.fn());
    expect(res.statusCode).toBe(409);
    expect(res.body.code).toBe('ERR_INSUFFICIENT_STOCK');
  });
});
