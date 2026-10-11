jest.mock('../models/Product', () => ({
  findOne: jest.fn(),
}));
jest.mock('../models/Warehouse', () => ({
  findOne: jest.fn(),
}));
jest.mock('../models/StockSerialNumber', () => ({
  find: jest.fn(),
}));
jest.mock('../services/journalService', () => ({}));
jest.mock('../services/cacheService', () => ({}));

const Product = require('../models/Product');
const Warehouse = require('../models/Warehouse');
const StockSerialNumber = require('../models/StockSerialNumber');
const { getPosAvailableSerialNumbers } = require('../controllers/salesLegacyController');

function makeFindOneQuery(value) {
  return { select: jest.fn().mockResolvedValue(value) };
}

describe('POS available serial numbers', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('returns only saleable serials for the selected company, product, and warehouse', async () => {
    const productId = '111111111111111111111111';
    const warehouseId = '222222222222222222222222';
    const companyId = '333333333333333333333333';
    const serials = [{ _id: 'serial-1', serialNo: 'SN-001' }];
    Product.findOne.mockReturnValue(makeFindOneQuery({ _id: productId }));
    Warehouse.findOne.mockReturnValue(makeFindOneQuery({ _id: warehouseId }));
    const query = {
      select: jest.fn(),
      sort: jest.fn(),
      lean: jest.fn().mockResolvedValue(serials),
    };
    query.select.mockReturnValue(query);
    query.sort.mockReturnValue(query);
    StockSerialNumber.find.mockReturnValue(query);
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };

    await getPosAvailableSerialNumbers({
      user: { company: { _id: companyId } },
      params: { productId },
      query: { warehouseId },
    }, res, jest.fn());

    expect(Product.findOne).toHaveBeenCalledWith({
      _id: productId,
      company: companyId,
      isActive: true,
      $or: [
        { trackingType: 'serial' },
        { trackSerialNumbers: true },
      ],
    });
    expect(Warehouse.findOne).toHaveBeenCalledWith({
      _id: warehouseId,
      company: companyId,
      isActive: { $ne: false },
    });
    expect(StockSerialNumber.find).toHaveBeenCalledWith({
      company: companyId,
      product: productId,
      warehouse: warehouseId,
      status: { $in: ['in_stock', 'returned'] },
    });
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ success: true, data: serials });
  });

  test('rejects invalid product or warehouse identifiers', async () => {
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };

    await getPosAvailableSerialNumbers({
      user: { company: { _id: 'company-1' } },
      params: { productId: 'invalid' },
      query: { warehouseId: 'invalid' },
    }, res, jest.fn());

    expect(res.status).toHaveBeenCalledWith(400);
    expect(StockSerialNumber.find).not.toHaveBeenCalled();
  });
});
