jest.mock('../lib/prisma', () => ({ dbClient: jest.fn() }));
jest.mock('../services/transactionService', () => ({ runInPrismaTransaction: jest.fn() }));
jest.mock('../utils/referenceNumbers', () => ({ nextReferenceNo: jest.fn() }));
jest.mock('../services/journalService', () => ({}));
jest.mock('../services/periodService', () => ({}));
jest.mock('../services/cacheService', () => ({}));

const { dbClient } = require('../lib/prisma');
const { runInPrismaTransaction } = require('../services/transactionService');
const { nextReferenceNo } = require('../utils/referenceNumbers');
const { createReceipt } = require('../controllers/arReceiptController');

describe('AR receipt creation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    nextReferenceNo.mockResolvedValue('RCP-2026-00042');
  });

  test('allocates a seeded-safe receipt reference and includes the linked bank account relation', async () => {
    const receipt = {
      id: 'receipt-1',
      companyId: 'company-1',
      referenceNo: 'RCP-2026-00042',
      clientId: 'client-1',
      amountReceived: 25,
      unallocatedAmount: 25,
      allocations: [],
      client: { id: 'client-1', name: 'Customer', code: 'CUS-1' },
      bankAccount: null,
    };
    const tx = {
      invoice: { findMany: jest.fn().mockResolvedValue([]) },
      aRReceipt: {
        create: jest.fn().mockResolvedValue({ id: 'receipt-1' }),
        findFirst: jest.fn().mockResolvedValue(receipt),
      },
      aRReceiptAllocation: { createMany: jest.fn() },
    };
    runInPrismaTransaction.mockImplementation((callback) => callback(tx));
    dbClient.mockReturnValue({
      client: { findFirst: jest.fn().mockResolvedValue({ id: 'client-1' }) },
      bankAccount: { findFirst: jest.fn() },
    });

    const req = {
      user: { company: { _id: 'company-1' }, id: 'user-1' },
      body: { client: 'client-1', amountReceived: 25 },
    };
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };

    await createReceipt(req, res, (err) => { throw err; });

    expect(nextReferenceNo).toHaveBeenCalledWith('company-1', 'RCP', {
      field: 'referenceNo',
      model: 'aRReceipt',
    });
    expect(tx.aRReceipt.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ referenceNo: 'RCP-2026-00042' }),
    }));
    expect(tx.aRReceipt.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      include: expect.objectContaining({ bankAccount: expect.any(Object) }),
    }));
    expect(res.status).toHaveBeenCalledWith(201);
  });

  test('returns a conflict when an explicitly supplied reference is already used', async () => {
    const duplicateError = Object.assign(new Error('unique constraint'), {
      code: 'P2002',
      meta: { target: ['company_id', 'reference_no'] },
    });
    runInPrismaTransaction.mockRejectedValue(duplicateError);
    dbClient.mockReturnValue({
      client: { findFirst: jest.fn().mockResolvedValue({ id: 'client-1' }) },
      bankAccount: { findFirst: jest.fn() },
    });

    const req = {
      user: { company: { _id: 'company-1' }, id: 'user-1' },
      body: { client: 'client-1', amountReceived: 25, referenceNo: 'CUSTOM-RCP-1' },
    };
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };

    await createReceipt(req, res, jest.fn());

    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      code: 'AR_RECEIPT_REFERENCE_EXISTS',
    }));
  });
});
