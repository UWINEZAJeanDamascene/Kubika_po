jest.mock('../lib/prisma', () => ({ prisma: {}, dbClient: jest.fn() }));
jest.mock('../services/transactionService', () => ({ runInTransaction: jest.fn() }));
jest.mock('../controllers/posManagerApprovalController', () => ({
  consumeApproval: jest.fn(),
  hashPayload: (payload) => require('crypto').createHash('sha256').update(JSON.stringify(payload || {})).digest('hex'),
}));

const { dbClient } = require('../lib/prisma');
const { runInTransaction } = require('../services/transactionService');
const { consumeApproval, hashPayload } = require('../controllers/posManagerApprovalController');
const support = require('../controllers/posCheckoutSupportController');
const { IDS, mockRes, makeReq } = require('./helpers/posE2eFixtures');

describe('POS checkout support recovery', () => {
  beforeEach(() => jest.clearAllMocks());

  test('exposes only tenant-scoped invoice summary for a conflicting request key', async () => {
    const db = {
      $queryRawUnsafe: jest.fn().mockResolvedValue([{
        request_key: 'conflict-key-123456',
        created_by_id: `${IDS.manager} `,
        cashier_name: 'Previous Cashier',
        status: 'completed',
        created_at: new Date('2026-10-12T10:00:00Z'),
        invoice_id: `${IDS.invoice} `,
        reference_no: 'INV-101',
        customer_name: 'Walk-in Customer',
        total_amount: '1180.00',
        invoice_status: 'fully_paid',
        invoice_date: new Date('2026-10-12T10:00:00Z'),
      }]),
    };
    dbClient.mockReturnValue(db);
    const res = mockRes();

    await support.getCheckoutRequest(makeReq({ params: { requestKey: 'conflict-key-123456' } }), res, jest.fn());

    expect(res.statusCode).toBe(200);
    expect(res.body.data).toMatchObject({
      cashierId: IDS.manager,
      cashierName: 'Previous Cashier',
      status: 'completed',
      invoice: { id: IDS.invoice, referenceNo: 'INV-101', totalAmount: 1180, status: 'fully_paid' },
    });
    expect(db.$queryRawUnsafe.mock.calls[0][0]).toContain('r.company_id = $1');
  });

  test('re-keys only a completed conflicting request after manager approval and writes an audit record', async () => {
    const requestData = { items: [{ productId: IDS.product, quantity: 1 }], paymentAmount: 1180 };
    const approvalPayload = {
      requestKey: 'conflict-key-123456',
      requestData,
      shouldSendEmail: false,
      linkedInvoiceId: IDS.invoice,
      reason: 'Separate order verified against the register log',
      confirmedNoMatchingSale: true,
    };
    const tx = {
      $queryRawUnsafe: jest.fn(async (sql) => {
        if (String(sql).includes('FROM pos_sale_requests')) return [{
          request_key: approvalPayload.requestKey,
          created_by_id: `${IDS.cashier} `,
          payload_hash: 'different-existing-payload-hash',
          invoice_id: `${IDS.invoice} `,
          status: 'completed',
        }];
        if (String(sql).includes('FROM invoices')) return [{ id: `${IDS.invoice} `, reference_no: 'INV-101' }];
        if (String(sql).includes('FROM pos_manager_approvals')) return [{ manager_id: `${IDS.manager} ` }];
        return [];
      }),
      $executeRawUnsafe: jest.fn().mockResolvedValue(1),
    };
    runInTransaction.mockImplementation((callback) => callback(tx));
    consumeApproval.mockResolvedValue(IDS.approval);
    const res = mockRes();

    await support.recoverCheckoutRequest(makeReq({
      params: { requestKey: approvalPayload.requestKey },
      body: { ...approvalPayload, approvalId: IDS.approval },
    }), res, (err) => { throw err; });

    expect(res.statusCode).toBe(200);
    expect(res.body.data.originalInvoiceReference).toBe('INV-101');
    expect(res.body.data.replacementRequestKey).toMatch(/^[a-f0-9]{48}$/);
    expect(consumeApproval).toHaveBeenCalledWith(expect.objectContaining({
      cashierId: IDS.cashier,
      action: 'checkout_recovery',
      payload: approvalPayload,
    }));
    expect(tx.$executeRawUnsafe).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO pos_sale_request_recoveries'),
      expect.stringMatching(/^[a-f0-9]{24}$/),
      IDS.company,
      approvalPayload.requestKey,
      res.body.data.replacementRequestKey,
      hashPayload(requestData),
      'different-existing-payload-hash',
      IDS.invoice,
      IDS.cashier,
      IDS.manager,
      approvalPayload.reason,
    );
  });

  test('refuses to re-key a request without a linked completed invoice', async () => {
    const tx = {
      $queryRawUnsafe: jest.fn().mockResolvedValue([{
        request_key: 'conflict-key-123456',
        created_by_id: `${IDS.manager} `,
        payload_hash: 'other-payload',
        invoice_id: null,
        status: 'processing',
      }]),
      $executeRawUnsafe: jest.fn(),
    };
    runInTransaction.mockImplementation((callback) => callback(tx));
    const res = mockRes();

    await support.recoverCheckoutRequest(makeReq({
      params: { requestKey: 'conflict-key-123456' },
      body: {
        requestData: { items: [] },
        shouldSendEmail: false,
        linkedInvoiceId: IDS.invoice,
        reason: 'No linked invoice to compare',
        confirmedNoMatchingSale: true,
        approvalId: IDS.approval,
      },
    }), res, jest.fn());

    expect(res.statusCode).toBe(409);
    expect(res.body.code).toBe('POS_CHECKOUT_RECOVERY_UNSAFE');
    expect(consumeApproval).not.toHaveBeenCalled();
    expect(tx.$executeRawUnsafe).not.toHaveBeenCalled();
  });
});
