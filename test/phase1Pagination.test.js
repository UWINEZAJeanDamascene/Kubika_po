const mockQueryRawUnsafe = jest.fn();
const mockDbClient = () => ({ $queryRawUnsafe: mockQueryRawUnsafe });

jest.mock('../lib/prisma', () => ({ dbClient: mockDbClient }));

describe('Phase 1 PostgreSQL pagination', () => {
  beforeEach(() => {
    mockQueryRawUnsafe.mockReset();
  });

  test('pages AR transaction unions in PostgreSQL', async () => {
    mockQueryRawUnsafe
      .mockResolvedValueOnce([{ total: 5 }])
      .mockResolvedValueOnce([{
        id: 'ar-inv-1',
        transaction_date: new Date('2026-01-02'),
        client: { _id: 'client-1', name: 'Client' },
        invoice: { _id: 'invoice-1', referenceNo: 'INV-1' },
        transaction_type: 'invoice_created',
        reference_no: 'INV-1',
        description: 'Invoice INV-1 created',
        amount: 25,
        direction: 'increase',
        reconciliation_status: 'pending',
      }]);

    const { getARTransactions } = require('../services/ledgerReadService');
    const result = await getARTransactions('company-1', {
      clientId: 'client-1',
      startDate: '2026-01-01',
      endDate: '2026-01-31',
    }, { page: 2, limit: 2 });

    expect(result).toEqual(expect.objectContaining({ total: 5, pages: 3, currentPage: 2 }));
    expect(result.items[0]).toEqual(expect.objectContaining({ _id: 'ar-inv-1', amount: 25 }));
    expect(mockQueryRawUnsafe).toHaveBeenCalledTimes(2);
    expect(mockQueryRawUnsafe.mock.calls[1][0]).toContain('LIMIT $');
    expect(mockQueryRawUnsafe.mock.calls[1][0]).toContain('OFFSET $');
    expect(mockQueryRawUnsafe.mock.calls[1].slice(-2)).toEqual([2, 2]);
  });

  test('pages AP transaction unions in PostgreSQL', async () => {
    mockQueryRawUnsafe
      .mockResolvedValueOnce([{ total: 1 }])
      .mockResolvedValueOnce([{
        id: 'ap-pay-1',
        transaction_date: new Date('2026-01-02'),
        supplier: { _id: 'supplier-1', name: 'Supplier' },
        payment: { _id: 'payment-1', referenceNo: 'PAY-1' },
        transaction_type: 'payment_posted',
        reference_no: 'PAY-1',
        description: 'Payment PAY-1',
        amount: 12,
        direction: 'decrease',
        reconciliation_status: 'pending',
      }]);

    const { getAPTransactions } = require('../services/ledgerReadService');
    const result = await getAPTransactions('company-1', { supplierId: 'supplier-1' }, { page: 1, limit: 10 });

    expect(result).toEqual(expect.objectContaining({ total: 1, pages: 1, currentPage: 1 }));
    expect(result.items[0]).toEqual(expect.objectContaining({ _id: 'ap-pay-1', direction: 'decrease' }));
    expect(mockQueryRawUnsafe.mock.calls[1][0]).toContain('ORDER BY transaction_date');
  });
});
