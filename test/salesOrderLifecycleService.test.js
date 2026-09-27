const { deriveSalesOrderStatus } = require('../services/salesOrderLifecycleService');

describe('Sales Order lifecycle status', () => {
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
});