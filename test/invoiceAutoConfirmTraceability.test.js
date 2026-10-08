jest.mock('../models/Invoice', () => ({
  findOne: jest.fn(),
  findByIdAndUpdate: jest.fn(),
}));
jest.mock('../models/Product', () => ({}));
jest.mock('../models/Client', () => ({ findOne: jest.fn() }));
jest.mock('../models/StockMovement', () => ({ create: jest.fn() }));
jest.mock('../models/DeliveryNote', () => ({ findOne: jest.fn() }));
jest.mock('../utils/lineProducts', () => ({
  loadLineProducts: jest.fn(),
  getLineProduct: jest.fn(),
}));
jest.mock('../services/journalService', () => ({
  createEntry: jest.fn(),
  createCOGSEntry: jest.fn(),
}));
jest.mock('../services/taxAutomationService', () => ({
  computeSalesTax: jest.fn(),
}));
jest.mock('../services/warehouseService', () => ({
  getStockLevel: jest.fn(),
  commitReservedStock: jest.fn(),
}));
jest.mock('../services/stockValidationService', () => ({
  reserveForOrder: jest.fn(),
}));
jest.mock('../services/cacheService', () => ({
  bumpCompanyFinancialCaches: jest.fn(),
}));
jest.mock('../services/ebmSalesService', () => ({
  submitInvoice: jest.fn(),
}));
jest.mock('../utils/productCost', () => ({
  resolveCogsUnitCost: jest.fn(),
}));
jest.mock('../services/notificationHelper', () => ({
  notifyPaymentReceived: jest.fn(),
}));
jest.mock('../services/transactionService', () => ({
  runInTransaction: (operation) => operation(),
}));
jest.mock('../lib/prisma', () => ({
  prisma: { invoiceLine: { update: jest.fn() } },
  dbClient: jest.fn(),
}));

const Invoice = require('../models/Invoice');
const Client = require('../models/Client');
const DeliveryNote = require('../models/DeliveryNote');
const StockMovement = require('../models/StockMovement');
const JournalService = require('../services/journalService');
const TaxAutomationService = require('../services/taxAutomationService');
const warehouseService = require('../services/warehouseService');
const stockValidationService = require('../services/stockValidationService');
const { loadLineProducts, getLineProduct } = require('../utils/lineProducts');
const { resolveCogsUnitCost } = require('../utils/productCost');
const { dbClient, prisma } = require('../lib/prisma');
const { confirmDraftInvoice } = require('../services/invoiceAutoConfirmService');

describe('Invoice confirmation from a delivery note', () => {
  let invoice;
  let product;
  let deliveryNoteLine;
  let db;

  beforeEach(() => {
    jest.clearAllMocks();
    product = {
      _id: 'product-1',
      name: 'Philips LED Tube Light 18W',
      isActive: true,
      isStockable: true,
      trackingType: 'batch',
      currentStock: 10,
      defaultWarehouse: 'warehouse-1',
    };
    invoice = {
      _id: 'invoice-1',
      status: 'draft',
      referenceNo: 'INV-1',
      invoiceDate: new Date('2026-10-01T00:00:00.000Z'),
      totalAmount: 200,
      client: 'client-1',
      lines: [{
        _id: 'invoice-line-1',
        product,
        qty: 2,
        quantity: 2,
        unitPrice: 100,
        lineSubtotal: 200,
        lineTax: 0,
        lineTotal: 200,
        warehouse: 'warehouse-1',
      }],
    };
    deliveryNoteLine = {
      invoiceLineId: 'invoice-line-1',
      qtyToDeliver: 2,
      batchId: 'batch-1',
      serialNumbers: [],
    };
    const client = { _id: 'client-1', name: 'Client' };
    const documentQuery = { populate: jest.fn().mockResolvedValue(invoice) };
    Invoice.findOne.mockReturnValue(documentQuery);
    Invoice.findByIdAndUpdate.mockResolvedValue(invoice);
    DeliveryNote.findOne.mockImplementation((filter) => (
      filter.status === 'draft'
        ? Promise.resolve({ status: 'draft', lines: [deliveryNoteLine] })
        : Promise.resolve(null)
    ));
    Client.findOne.mockResolvedValue(client);
    loadLineProducts.mockResolvedValue([product]);
    getLineProduct.mockReturnValue(product);
    resolveCogsUnitCost.mockResolvedValue(5);
    TaxAutomationService.computeSalesTax.mockResolvedValue({
      journalLines: [],
      totals: { tax: 0, net: 200, gross: 200 },
      lines: [],
    });
    JournalService.createEntry.mockResolvedValue({ _id: 'revenue-entry-1' });
    JournalService.createCOGSEntry.mockResolvedValue({ _id: 'cogs-entry-1' });
    prisma.invoiceLine.update.mockResolvedValue({});
    warehouseService.getStockLevel.mockResolvedValue({ qty_available: 10 });
    warehouseService.commitReservedStock.mockResolvedValue({ currentStock: 8 });
    stockValidationService.reserveForOrder.mockResolvedValue({});
    db = {
      invoice: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      client: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      product: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    };
    dbClient.mockReturnValue(db);
  });

  test('uses the picked batch assignment and leaves stock deduction to the delivery note', async () => {
    await confirmDraftInvoice('company-1', 'invoice-1', 'user-1', { submitEbm: false });

    expect(Invoice.findByIdAndUpdate).toHaveBeenCalledWith(
      'invoice-1',
      expect.objectContaining({ status: 'confirmed', stockDeducted: false }),
    );
    expect(warehouseService.getStockLevel).not.toHaveBeenCalled();
    expect(stockValidationService.reserveForOrder).not.toHaveBeenCalled();
    expect(warehouseService.commitReservedStock).not.toHaveBeenCalled();
    expect(StockMovement.create).not.toHaveBeenCalled();
  });

  test('keeps the invoice unconfirmed when a batch-tracked line has no pick assignment', async () => {
    deliveryNoteLine.batchId = null;

    await expect(
      confirmDraftInvoice('company-1', 'invoice-1', 'user-1', { submitEbm: false }),
    ).rejects.toMatchObject({ code: 'ERR_TRACEABILITY_REQUIRED', statusCode: 409 });

    expect(Invoice.findByIdAndUpdate).not.toHaveBeenCalled();
    expect(stockValidationService.reserveForOrder).not.toHaveBeenCalled();
  });
});
