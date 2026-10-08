const SalesOrder = require('../models/SalesOrder');
const DeliveryNote = require('../models/DeliveryNote');
const Invoice = require('../models/Invoice');
const Product = require('../models/Product');
const {
  deriveSalesOrderStatus,
  syncSalesOrderLifecycle,
} = require('../services/salesOrderLifecycleService');

function queryResult(result) {
  return {
    select: jest.fn().mockReturnThis(),
    lean: jest.fn().mockResolvedValue(result),
  };
}

describe('Sales Order lifecycle status', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('does not advance until every active delivery is delivered', () => {
    expect(deriveSalesOrderStatus('packed', ['delivered', 'dispatched'], ['confirmed']))
      .toBe('packed');
  });

  test('advances to delivered when all deliveries are complete and no invoice exists', () => {
    expect(deriveSalesOrderStatus('packed', ['delivered'], []))
      .toBe('delivered');
  });

  test('advances to invoiced when all deliveries are complete and an invoice is outstanding', () => {
    expect(deriveSalesOrderStatus('packed', ['delivered'], ['confirmed']))
      .toBe('invoiced');
  });

  test('closes only after all active invoices are fully paid', () => {
    expect(deriveSalesOrderStatus('invoiced', ['delivered'], ['fully_paid', 'partially_paid']))
      .toBe('invoiced');
    expect(deriveSalesOrderStatus('invoiced', ['delivered'], ['fully_paid', 'fully_paid']))
      .toBe('closed');
  });

  test('ignores cancelled records and preserves terminal order states', () => {
    expect(deriveSalesOrderStatus('packed', ['delivered', 'cancelled'], ['cancelled']))
      .toBe('delivered');
    expect(deriveSalesOrderStatus('closed', ['delivered'], ['fully_paid']))
      .toBe('closed');
    expect(deriveSalesOrderStatus('cancelled', ['delivered'], ['fully_paid']))
      .toBe('cancelled');
  });

  test('reconciles delivered notes whose deliveredQty snapshot is still zero', async () => {
    jest.spyOn(SalesOrder, 'findOne').mockReturnValue(queryResult({
      _id: 'so-1',
      status: 'packed',
      lines: [{ _id: 'so-line-1', product: 'product-1', qty: 3, qtyShipped: 3 }],
      fulfillmentPercent: 0,
      fulfillmentStatus: 'pending',
      isBackorder: false,
    }));
    jest.spyOn(DeliveryNote, 'find').mockReturnValue(queryResult([{
      status: 'delivered',
      lines: [{
        salesOrderLineId: 'so-line-1',
        product: 'product-1',
        deliveredQty: 0,
        qtyToDeliver: 3,
      }],
    }]));
    jest.spyOn(Invoice, 'find').mockReturnValue(queryResult([{ status: 'confirmed' }]));
    jest.spyOn(Product, 'find').mockReturnValue(queryResult([{ _id: 'product-1', isStockable: true }]));
    jest.spyOn(SalesOrder, 'findOneAndUpdate').mockResolvedValue({
      status: 'invoiced',
      fulfillmentStatus: 'fulfilled',
      fulfillmentPercent: 100,
      isBackorder: false,
    });

    await syncSalesOrderLifecycle('so-1', 'company-1');

    expect(SalesOrder.findOneAndUpdate).toHaveBeenCalledWith(
      { _id: 'so-1', company: 'company-1', status: 'packed' },
      {
        $set: {
          status: 'invoiced',
          fulfillmentStatus: 'fulfilled',
          fulfillmentPercent: 100,
          isBackorder: false,
        },
      },
      { new: true },
    );
  });
});