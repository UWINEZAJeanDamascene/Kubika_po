const DeliveryNoteController = require('../controllers/deliveryNoteController');
const PickPackController = require('../controllers/pickPackController');
const SalesOrderController2 = require('../controllers/salesOrderController2');
const InvoiceController = require('../controllers/invoiceController');

const DeliveryNote = require('../models/DeliveryNote');
const PickPack = require('../models/PickPack');
const SalesOrder = require('../models/SalesOrder');
const Invoice = require('../models/Invoice');
const Client = require('../models/Client');
const Quotation = require('../models/Quotation');
const Warehouse = require('../models/Warehouse');
const Product = require('../models/Product');
const User = require('../models/User');

function buildQueryChain(data) {
  return {
    populate: jest.fn(() => {
      throw new Error('populate should not be called');
    }),
    sort: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    skip: jest.fn().mockReturnThis(),
    lean: jest.fn().mockResolvedValue(data),
    select: jest.fn().mockReturnThis(),
  };
}

describe('Priority controller responses avoid populate calls', () => {
  beforeEach(() => {
    jest.restoreAllMocks();
  });

  test('delivery notes list response still hydrates only required fields', async () => {
    const req = { user: { company: { _id: 'company-1' } }, query: { page: 1, limit: 10 } };
    const res = { json: jest.fn() };
    const next = jest.fn();

    const doc = {
      _id: 'dn-1',
      company: 'company-1',
      client: 'c-1',
      quotation: 'q-1',
      salesOrder: 'so-1',
      invoice: 'i-1',
      warehouse: 'w-1',
      lines: [{ _id: 'l1', product: 'p-1', qtyToDeliver: 2, lineTotal: 60 }],
      createdBy: 'u-1',
      confirmedBy: 'u-2',
    };

    jest.spyOn(DeliveryNote, 'countDocuments').mockResolvedValue(1);
    jest.spyOn(DeliveryNote, 'find').mockReturnValue(buildQueryChain([doc]));
    jest.spyOn(Client, 'find').mockReturnValue(buildQueryChain([{ _id: 'c-1', name: 'Acme', code: 'A1', contact: { email: 'a@x.com' }, taxId: 'TIN1' }]));
    jest.spyOn(Quotation, 'find').mockReturnValue(buildQueryChain([{ _id: 'q-1', referenceNo: 'Q-1' }]));
    jest.spyOn(SalesOrder, 'find').mockReturnValue(buildQueryChain([{ _id: 'so-1', referenceNo: 'SO-1', quotation: 'q-1' }]));
    jest.spyOn(Invoice, 'find').mockReturnValue(buildQueryChain([{ _id: 'i-1', referenceNo: 'INV-1', status: 'confirmed', grandTotal: 60, currencyCode: 'RWF' }]));
    jest.spyOn(Warehouse, 'find').mockReturnValue(buildQueryChain([{ _id: 'w-1', name: 'Main', code: 'WH1' }]));
    jest.spyOn(Product, 'find').mockReturnValue(buildQueryChain([{ _id: 'p-1', name: 'Widget', sku: 'W-1', unit: 'pcs' }]));
    jest.spyOn(User, 'find').mockReturnValue(buildQueryChain([{ _id: 'u-1', name: 'User One', email: 'u1@test.com' }, { _id: 'u-2', name: 'User Two', email: 'u2@test.com' }]));

    await DeliveryNoteController.getDeliveryNotes(req, res, next);

    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
    const payload = res.json.mock.calls[0][0];
    expect(payload.data[0].client).toMatchObject({ name: 'Acme', code: 'A1' });
    expect(payload.data[0].lines[0].product).toMatchObject({ name: 'Widget', sku: 'W-1' });
    expect(next).not.toHaveBeenCalled();
  });

  test('pick pack list response still exposes required warehouse and product fields', async () => {
    const req = { user: { company: { _id: 'company-1' } }, query: { page: 1, limit: 10 } };
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    const next = jest.fn();

    const doc = {
      _id: 'pp-1',
      company: 'company-1',
      salesOrder: 'so-1',
      client: 'c-1',
      warehouse: 'w-1',
      assignedTo: 'u-1',
      lines: [{ _id: 'l1', product: 'p-1', qtyToPick: 2, qtyPicked: 2, qtyPacked: 2 }],
    };

    jest.spyOn(PickPack, 'countDocuments').mockResolvedValue(1);
    jest.spyOn(PickPack, 'find').mockReturnValue(buildQueryChain([doc]));
    jest.spyOn(SalesOrder, 'find').mockReturnValue(buildQueryChain([{ _id: 'so-1', referenceNo: 'SO-1', status: 'confirmed' }]));
    jest.spyOn(Client, 'find').mockReturnValue(buildQueryChain([{ _id: 'c-1', name: 'Customer', code: 'C1' }]));
    jest.spyOn(Warehouse, 'find').mockReturnValue(buildQueryChain([{ _id: 'w-1', name: 'Main', code: 'WH1' }]));
    jest.spyOn(Product, 'find').mockReturnValue(buildQueryChain([{ _id: 'p-1', name: 'Widget', sku: 'W-1' }]));
    jest.spyOn(User, 'find').mockReturnValue(buildQueryChain([{ _id: 'u-1', name: 'User One', email: 'u1@test.com' }]));

    await PickPackController.getPickPacks(req, res, next);

    expect(res.status).toHaveBeenCalledWith(200);
    const payload = res.json.mock.calls[0][0];
    expect(payload.data[0].salesOrder).toMatchObject({ referenceNo: 'SO-1' });
    expect(payload.data[0].client).toMatchObject({ name: 'Customer', code: 'C1' });
    expect(payload.data[0].lines[0].product).toMatchObject({ name: 'Widget', sku: 'W-1' });
  });

  test('sales orders list response keeps client and product fields', async () => {
    const req = { user: { company: { _id: 'company-1' } }, query: { page: 1, limit: 10 } };
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    const next = jest.fn();

    const doc = {
      _id: 'so-1',
      company: 'company-1',
      client: 'c-1',
      lines: [{ _id: 'l1', product: 'p-1', qty: 2, unit: 'pcs' }],
      createdBy: 'u-1',
    };

    jest.spyOn(SalesOrder, 'countDocuments').mockResolvedValue(1);
    jest.spyOn(SalesOrder, 'find').mockReturnValue(buildQueryChain([doc]));
    jest.spyOn(Client, 'find').mockReturnValue(buildQueryChain([{ _id: 'c-1', name: 'Customer', code: 'C1', tin: 'TIN-1' }]));
    jest.spyOn(Product, 'find').mockReturnValue(buildQueryChain([{ _id: 'p-1', name: 'Widget', sku: 'W-1', unit: 'pcs', taxRate: 18, taxCode: 'A', trackingType: 'none', isStockable: true }]));
    jest.spyOn(User, 'find').mockReturnValue(buildQueryChain([{ _id: 'u-1', name: 'User One', email: 'u1@test.com' }]));

    await SalesOrderController2.getSalesOrders(req, res, next);

    expect(res.status).toHaveBeenCalledWith(200);
    const payload = res.json.mock.calls[0][0];
    expect(payload.data[0].client).toMatchObject({ name: 'Customer', code: 'C1' });
    expect(payload.data[0].lines[0].product).toMatchObject({ name: 'Widget', sku: 'W-1' });
  });

  test('invoice list response preserves client and line product fields', async () => {
    const req = { user: { company: { _id: 'company-1' } }, query: { page: 1, limit: 10 } };
    const res = { json: jest.fn() };
    const next = jest.fn();

    const doc = {
      _id: 'inv-1',
      company: 'company-1',
      client: 'c-1',
      lines: [{ _id: 'l1', product: 'p-1', qty: 2, unit: 'pcs' }],
      createdBy: 'u-1',
      quotation: 'q-1',
    };

    jest.spyOn(Invoice, 'countDocuments').mockResolvedValue(1);
    jest.spyOn(Invoice, 'find').mockReturnValue(buildQueryChain([doc]));
    jest.spyOn(Client, 'find').mockReturnValue(buildQueryChain([{ _id: 'c-1', name: 'Customer', code: 'C1', contact: { email: 'a@x.com' } }]));
    jest.spyOn(Product, 'find').mockReturnValue(buildQueryChain([{ _id: 'p-1', name: 'Widget', sku: 'W-1', unit: 'pcs' }]));
    jest.spyOn(User, 'find').mockReturnValue(buildQueryChain([{ _id: 'u-1', name: 'User One', email: 'u1@test.com' }]));
    jest.spyOn(Quotation, 'find').mockReturnValue(buildQueryChain([{ _id: 'q-1', referenceNo: 'Q-1' }]));

    await InvoiceController.getInvoices(req, res, next);

    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
    const payload = res.json.mock.calls[0][0];
    expect(payload.data[0].client).toMatchObject({ name: 'Customer', code: 'C1' });
    expect(payload.data[0].lines[0].product).toMatchObject({ name: 'Widget', sku: 'W-1' });
  });
});
