jest.mock('../services/transactionService', () => ({
  runInTransaction: jest.fn((operation) => operation(null)),
}));
jest.mock('../services/cacheService', () => ({
  bumpCompanyFinancialCaches: jest.fn(),
  bumpCompanyStockCaches: jest.fn(),
}));

const DeliveryNoteController = require('../controllers/deliveryNoteController');
const DeliveryNote = require('../models/DeliveryNote');
const Invoice = require('../models/Invoice');
const prismaModule = require('../lib/prisma');

describe('Delivery note confirmation', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('confirms a note when PostgreSQL-backed lines are plain objects', async () => {
    const invoiceLine = { _id: 'invoice-line-1', quantity: 1, qtyDelivered: 0 };
    const invoiceLines = [invoiceLine];
    invoiceLines.id = (id) => invoiceLines.find((line) => line._id === id) || null;
    const invoice = { _id: 'invoice-1', status: 'confirmed', lines: invoiceLines };
    const deliveryNote = {
      _id: 'delivery-note-1',
      invoice: 'invoice-1',
      warehouse: null,
      status: 'draft',
      referenceNo: 'DN-1',
      lines: [{
        _id: 'delivery-line-1',
        invoiceLineId: 'invoice-line-1',
        qtyToDeliver: 0,
      }],
      save: jest.fn(async () => deliveryNote),
    };

    jest.spyOn(DeliveryNote, 'findOne').mockReturnValue({
      select: () => ({ lean: async () => deliveryNote }),
    });
    jest.spyOn(Invoice, 'find').mockReturnValue({
      lean: async () => [{ _id: 'invoice-1', referenceNo: 'INV-1', status: 'confirmed' }],
    });
    jest.spyOn(Invoice, 'findById').mockResolvedValue(invoice);
    jest.spyOn(prismaModule, 'dbClient').mockReturnValue({
      $queryRaw: jest.fn(async () => [{ id: 'delivery-note-1' }]),
    });
    const req = {
      user: { company: { _id: 'company-1' }, id: 'user-1' },
      params: { id: 'delivery-note-1' },
      body: {},
    };
    const res = { json: jest.fn() };
    const next = jest.fn();

    await DeliveryNoteController.confirmDelivery(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(deliveryNote.status).toBe('confirmed');
    expect(deliveryNote.save).toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
  });
});
