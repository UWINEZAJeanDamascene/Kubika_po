jest.mock('../models/Supplier', () => ({
  findOne: jest.fn(),
}));

jest.mock('../models/StockMovement', () => ({
  countDocuments: jest.fn(),
  find: jest.fn(),
}));

jest.mock('../models/PurchaseOrder', () => ({
  find: jest.fn(),
}));

const Supplier = require('../models/Supplier');
const StockMovement = require('../models/StockMovement');
const PurchaseOrder = require('../models/PurchaseOrder');
const { getSupplierPurchaseHistory } = require('../controllers/supplierController');

describe('supplier purchase history', () => {
  afterEach(() => jest.clearAllMocks());

  test('includes purchase-order receipt movements when older rows lack supplier ids', async () => {
    Supplier.findOne.mockResolvedValue({ _id: 'supplier-id' });
    PurchaseOrder.find.mockReturnValue({
      select: jest.fn().mockResolvedValue([{ _id: 'purchase-order-id' }]),
    });
    StockMovement.countDocuments.mockResolvedValue(1);

    const rows = [{
      _id: 'movement-id',
      movementDate: new Date('2026-10-08T00:00:00.000Z'),
      quantity: '3.0000',
      totalCost: '300.00',
      product: { name: 'Product', sku: 'SKU-1', unit: 'each' },
    }];
    StockMovement.find.mockImplementation(() => {
      const query = {
        populate: jest.fn(() => query),
        sort: jest.fn(() => query),
        limit: jest.fn(() => query),
        skip: jest.fn(() => query),
        then: (resolve, reject) => Promise.resolve(rows).then(resolve, reject),
      };
      return query;
    });

    const req = {
      user: { company: { _id: 'company-id' } },
      params: { id: 'supplier-id' },
      query: {},
    };
    const res = {
      json: jest.fn(),
      status: jest.fn().mockReturnThis(),
    };
    const next = jest.fn();

    await getSupplierPurchaseHistory(req, res, next);

    const historyQuery = StockMovement.find.mock.calls[0][0];
    expect(historyQuery.$or).toEqual([
      { supplier: 'supplier-id' },
      {
        referenceModel: 'PurchaseOrder',
        referenceDocument: { $in: ['purchase-order-id'] },
      },
    ]);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      success: true,
      summary: expect.objectContaining({
        totalPurchases: 1,
        totalAmount: 300,
        totalQuantity: 3,
        lastPurchaseDate: new Date('2026-10-08T00:00:00.000Z'),
      }),
      data: rows,
    }));
    expect(next).not.toHaveBeenCalled();
  });
});
