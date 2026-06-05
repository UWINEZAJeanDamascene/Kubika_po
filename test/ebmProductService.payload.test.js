jest.mock('../models/Product', () => ({
  findOne: jest.fn(),
}));

jest.mock('../models/Warehouse', () => ({
  findOne: jest.fn(),
}));

jest.mock('../models/EBMItemClass', () => ({
  exists: jest.fn(async () => true),
}));

jest.mock('../models/EBMCode', () => ({
  exists: jest.fn(async () => true),
}));

jest.mock('../services/ebmBranchService', () => ({
  ensureBranchRegistered: jest.fn(async () => true),
}));

jest.mock('../services/ebmService', () => ({
  getConfig: jest.fn(() => ({ mode: 'mock' })),
  saveItems: jest.fn(async () => ({ resultCd: '000' })),
}));

const Product = require('../models/Product');
const Warehouse = require('../models/Warehouse');
const ebmService = require('../services/ebmService');
const EBMProductService = require('../services/ebmProductService');

describe('EBM product registration payload', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('includes VSDC saveItems optional item registration fields when available', async () => {
    const product = {
      _id: 'product-1',
      company: 'company-1',
      name: 'Premium Rice 25kg',
      sku: 'RICE-25',
      barcode: '1234567890123456789012345',
      description: 'Long grain rice for wholesale',
      sellingPrice: 25000,
      lowStockThreshold: 12,
      isActive: true,
      defaultWarehouse: 'warehouse-1',
      taxCode: 'B',
      ebm: {
        itemClassCd: '5022110100',
        taxTyCd: 'B',
        pkgUnitCd: 'BG',
        qtyUnitCd: 'KG',
        itemTyCd: '2',
        orgnNatCd: 'RW',
        itemStdNm: 'Rice 25kg bag',
        btchNo: 'BATCH-2026-001',
        addInfo: 'Use FIFO for warehouse dispatch',
        sftyQty: 15,
        isrcAplcbYn: 'N',
      },
      save: jest.fn(async function save() {
        return this;
      }),
    };

    Product.findOne.mockResolvedValue(product);
    Warehouse.findOne.mockReturnValue({
      lean: jest.fn(async () => ({ _id: 'warehouse-1', rraBranchId: '00' })),
    });

    await EBMProductService.registerProduct('company-1', 'product-1', {
      tin: '999991130',
      companyName: 'Test Company',
    });

    expect(ebmService.saveItems).toHaveBeenCalledWith(
      expect.objectContaining({
        itemStdNm: 'Rice 25kg bag',
        btchNo: 'BATCH-2026-001',
        bcd: '12345678901234567890',
        addInfo: 'Use FIFO for warehouse dispatch',
        sftyQty: 15,
      }),
    );
  });
});
