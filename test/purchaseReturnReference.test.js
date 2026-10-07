jest.mock('../models/PurchaseReturn', () => ({
  create: jest.fn(),
  find: jest.fn(),
}));
jest.mock('../models/GoodsReceivedNote', () => ({
  findOne: jest.fn(),
}));
jest.mock('../utils/referenceNumbers', () => ({
  ...jest.requireActual('../utils/referenceNumbers'),
  nextReferenceNo: jest.fn(),
}));
jest.mock('../services/journalService', () => ({}));
jest.mock('../services/transactionService', () => ({}));
jest.mock('../services/emailService', () => ({}));
jest.mock('../services/cacheService', () => ({}));

const PurchaseReturn = require('../models/PurchaseReturn');
const GoodsReceivedNote = require('../models/GoodsReceivedNote');
const { nextReferenceNo } = require('../utils/referenceNumbers');
const { createPurchaseReturn } = require('../controllers/purchaseReturnController');

describe('purchase return supplier credit note number', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('generates the supplier credit note number on the server', async () => {
    const grn = {
      _id: 'grn-1',
      company: 'company-1',
      supplier: 'supplier-1',
      warehouse: 'warehouse-1',
      status: 'confirmed',
      lines: [{ _id: 'grn-line-1', product: 'product-1', qtyReceived: 2, unitCost: 50, taxRate: 0 }],
    };
    const createdReturn = { _id: 'return-1', referenceNo: 'PRN-2026-00001' };
    GoodsReceivedNote.findOne.mockResolvedValue(grn);
    PurchaseReturn.find.mockReturnValue({
      lean: jest.fn().mockResolvedValue([]),
    });
    nextReferenceNo.mockResolvedValue('SCN-2026-00001');
    PurchaseReturn.create.mockImplementation(async (data) => ({
      ...data,
      _id: createdReturn._id,
      referenceNo: createdReturn.referenceNo,
    }));

    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
    };

    await createPurchaseReturn({
      user: { company: { _id: 'company-1' }, id: 'user-1' },
      body: {
        grn: 'grn-1',
        reason: 'Damaged goods',
        supplierCreditNoteNo: 'USER-ENTERED-VALUE',
        lines: [{ grnLine: 'grn-line-1', qtyReturned: 1 }],
      },
    }, res, jest.fn());

    expect(nextReferenceNo).toHaveBeenCalledWith('company-1', 'SCN', {
      field: 'supplierCreditNoteNo',
      model: 'purchaseReturn',
    });
    expect(PurchaseReturn.create).toHaveBeenCalledWith(expect.objectContaining({
      supplierCreditNoteNo: 'SCN-2026-00001',
    }));
    expect(res.status).toHaveBeenCalledWith(201);
  });
});
