'use strict';

jest.mock('../models/Product', () => ({ find: jest.fn() }));
jest.mock('../models/StockLevel', () => ({ find: jest.fn() }));
jest.mock('../models/StockSerialNumber', () => ({ find: jest.fn(), updateMany: jest.fn() }));
jest.mock('../models/StockMovement', () => ({ findOne: jest.fn(), updateMany: jest.fn() }));
jest.mock('../models/TillSession', () => ({ findOne: jest.fn() }));
jest.mock('../models/Warehouse', () => ({ findOne: jest.fn() }));
jest.mock('../models/SystemSettings', () => ({ findOne: jest.fn() }));
jest.mock('../services/AuditLogService', () => ({ log: jest.fn() }));
jest.mock('../services/posRegisterService', () => ({
  findClaimedRegister: jest.fn(),
}));
jest.mock('../services/transactionService', () => ({
  runInTransaction: jest.fn(async (operation) => operation(null)),
}));
jest.mock('../lib/prisma', () => ({ dbClient: jest.fn() }));

const Product = require('../models/Product');
const StockLevel = require('../models/StockLevel');
const StockSerialNumber = require('../models/StockSerialNumber');
const StockMovement = require('../models/StockMovement');
const TillSession = require('../models/TillSession');
const Warehouse = require('../models/Warehouse');
const SystemSettings = require('../models/SystemSettings');
const AuditLogService = require('../services/AuditLogService');
const { findClaimedRegister } = require('../services/posRegisterService');
const { dbClient } = require('../lib/prisma');
const { verifyCapability } = require('../services/posOfflineCapabilityService');
const { issueSnapshot, listConflicts, resolveConflict } = require('../controllers/posOfflineController');

const IDS = {
  company: 'aaaaaaaaaaaaaaaaaaaaaaaa',
  user: 'bbbbbbbbbbbbbbbbbbbbbbbb',
  register: 'cccccccccccccccccccccccc',
  warehouse: 'dddddddddddddddddddddddd',
  till: 'eeeeeeeeeeeeeeeeeeeeeeee',
  product: 'ffffffffffffffffffffffff',
  conflict: '111111111111111111111111',
  invoice: '222222222222222222222222',
};

function response() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; },
  };
}

function query(value) {
  return { select: jest.fn().mockReturnThis(), limit: jest.fn().mockReturnThis(), lean: jest.fn().mockResolvedValue(value) };
}

describe('POS offline controller', () => {
  const previousSecret = process.env.JWT_SECRET;
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.JWT_SECRET = 'unit-test-secret-that-is-at-least-32-characters';
    dbClient.mockReturnValue({
      $queryRawUnsafe: jest.fn().mockResolvedValue([]),
      $executeRawUnsafe: jest.fn().mockResolvedValue(1),
    });
  });
  afterAll(() => {
    if (previousSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = previousSecret;
  });

  test('issues a signed capability bound to an enabled cashier/device/register/warehouse/till', async () => {
    SystemSettings.findOne.mockReturnValue({ lean: jest.fn().mockResolvedValue({
      posOfflineEnabled: true,
      posOfflineMaxHours: 24,
      posOfflineQueueLimit: 100000,
      posNegativeStockEscalationDays: 3,
      allowNegativeStock: false,
    }) });
    findClaimedRegister.mockResolvedValue({ code: 'REG-01' });
    Warehouse.findOne.mockReturnValue({ lean: jest.fn().mockResolvedValue({ _id: IDS.warehouse }) });
    TillSession.findOne.mockReturnValue({ lean: jest.fn().mockResolvedValue({ _id: IDS.till }) });
    Product.find.mockReturnValue(query([{
      _id: IDS.product,
      name: 'Widget',
      sellingPrice: 100,
      taxRate: 0,
      taxCode: 'B',
      isStockable: true,
      trackingType: 'none',
      averageCost: 40,
    }]));
    StockLevel.find.mockReturnValue({ lean: jest.fn().mockResolvedValue([{
      product_id: IDS.product,
      qty_on_hand: 5,
      qty_reserved: 1,
    }]) });
    StockSerialNumber.find.mockReturnValue(query([]));
    const database = dbClient();
    database.$queryRawUnsafe.mockImplementation(async (sql) => (
      String(sql).includes('FROM warehouses w')
        ? [{ priceListId: '888888888888888888888888', productId: IDS.product, price: '75' }]
        : []
    ));

    const res = response();
    await issueSnapshot({
      user: { id: IDS.user, company: { _id: IDS.company } },
      body: { deviceId: '77777777-7777-4777-8777-777777777777', registerId: IDS.register, warehouseId: IDS.warehouse },
    }, res, (error) => { throw error; });

    expect(res.statusCode).toBe(200);
    expect(res.body.data.productCount).toBe(1);
    const claims = verifyCapability(res.body.data.capability);
    expect(claims).toMatchObject({
      companyId: IDS.company,
      userId: IDS.user,
      registerId: IDS.register,
      warehouseId: IDS.warehouse,
      tillSessionId: IDS.till,
    });
    const snapshotInsert = database.$executeRawUnsafe.mock.calls.find(([sql]) => String(sql).includes('INSERT INTO pos_offline_snapshots'));
    const snapshotData = JSON.parse(snapshotInsert[8]);
    expect(snapshotData.products[IDS.product]).toMatchObject({ price: 75, standardPrice: 100 });
    expect(snapshotData.priceListId).toBe('888888888888888888888888');
    expect(database.$executeRawUnsafe).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO pos_offline_snapshots'),
      expect.any(String),
      IDS.company,
      IDS.user,
      expect.any(String),
      IDS.register,
      IDS.warehouse,
      IDS.till,
      expect.stringContaining('"taxRate":18'),
      100000,
      expect.any(Date),
      expect.any(Date),
    );
  });

  test('does not issue capabilities when company offline POS is disabled', async () => {
    SystemSettings.findOne.mockReturnValue({ lean: jest.fn().mockResolvedValue({ posOfflineEnabled: false }) });
    const res = response();
    await issueSnapshot({
      user: { id: IDS.user, company: { _id: IDS.company } },
      body: { deviceId: '77777777-7777-4777-8777-777777777777', registerId: IDS.register, warehouseId: IDS.warehouse },
    }, res, (error) => { throw error; });
    expect(res.statusCode).toBe(403);
    expect(res.body.code).toBe('POS_OFFLINE_DISABLED');
    expect(Product.find).not.toHaveBeenCalled();
  });

  test('lists conflicts after updating overdue open conflicts to escalated', async () => {
    const database = dbClient();
    database.$queryRawUnsafe.mockResolvedValue([{ id: IDS.conflict, status: 'escalated' }]);
    const res = response();
    await listConflicts({ user: { company: { _id: IDS.company } } }, res, (error) => { throw error; });
    expect(database.$executeRawUnsafe).toHaveBeenCalledWith(expect.stringContaining("status = 'escalated'"), IDS.company);
    expect(res.body.data).toEqual([{ id: IDS.conflict, status: 'escalated' }]);
  });

  test('requires exact unique available serial assignment and audits manager resolution', async () => {
    const database = dbClient();
    database.$queryRawUnsafe.mockResolvedValue([{
      id: IDS.conflict,
      offlineSaleId: 'offline-sale-id-123',
      invoiceId: IDS.invoice,
      productId: IDS.product,
      warehouseId: IDS.warehouse,
      conflictType: 'serial',
      details: { quantity: 2 },
      status: 'open',
      createdAt: new Date(),
    }]);
    StockSerialNumber.find.mockReturnValue(query([{ serialNo: 'SERIAL-1' }, { serialNo: 'SERIAL-2' }]));
    StockSerialNumber.updateMany.mockResolvedValue({ modifiedCount: 2 });
    StockMovement.updateMany.mockResolvedValue({ modifiedCount: 1 });
    AuditLogService.log.mockResolvedValue(undefined);
    const req = {
      user: { id: IDS.user, company: { _id: IDS.company } },
      params: { conflictId: IDS.conflict },
      body: { resolution: 'assign_serials', serialNumbers: ['serial-1', 'serial-2'], reason: 'Verified alternate stock serials.' },
      ip: '127.0.0.1',
      get: () => 'test-agent',
    };
    const res = response();
    await resolveConflict(req, res, (error) => { throw error; });

    expect(res.statusCode).toBe(200);
    expect(StockSerialNumber.updateMany).toHaveBeenCalled();
    expect(StockMovement.updateMany).toHaveBeenCalled();
    expect(AuditLogService.log).toHaveBeenCalledWith(expect.objectContaining({
      action: 'pos_offline_conflict.resolve',
      userId: IDS.user,
      entityId: IDS.conflict,
    }));
  });

  test('does not silently resolve a serial conflict without exact serials', async () => {
    dbClient().$queryRawUnsafe.mockResolvedValue([{
      id: IDS.conflict,
      productId: IDS.product,
      warehouseId: IDS.warehouse,
      conflictType: 'serial',
      details: { quantity: 2 },
      status: 'open',
    }]);
    const res = response();
    await resolveConflict({
      user: { id: IDS.user, company: { _id: IDS.company } },
      params: { conflictId: IDS.conflict },
      body: { resolution: 'assign_serials', serialNumbers: ['SERIAL-1'], reason: 'Only one provided.' },
    }, res, (error) => {
      res.status(error.status).json({ success: false, code: error.code, message: error.message });
    });
    expect(res.statusCode).toBe(400);
    expect(res.body.code).toBe('POS_OFFLINE_SERIAL_ASSIGNMENT_INVALID');
    expect(StockSerialNumber.updateMany).not.toHaveBeenCalled();
  });
});
