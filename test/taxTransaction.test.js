const {
  taxTransactionToApi,
  taxTransactionTranslateCreate,
} = require('../utils/taxMappers');
const TaxTransactionService = require('../services/taxTransactionService');

describe('taxMappers', () => {
  test('taxTransactionTranslateCreate flattens nested period', () => {
    const row = taxTransactionTranslateCreate({
      _id: '507f1f77bcf86cd799439011',
      company: '507f1f77bcf86cd799439012',
      taxType: 'vat_output',
      direction: 'output',
      amount: 180,
      sourceType: 'invoice',
      accountCode: '2220',
      period: { month: 3, year: 2026 },
      date: '2026-03-15T10:00:00.000Z',
    });

    expect(row.periodMonth).toBe(3);
    expect(row.periodYear).toBe(2026);
    expect(row.amount).toBe('180.0000');
  });

  test('taxTransactionToApi rebuilds period and virtual flags', () => {
    const api = taxTransactionToApi({
      id: '507f1f77bcf86cd799439011',
      companyId: '507f1f77bcf86cd799439012',
      taxType: 'vat_input',
      direction: 'input',
      amount: '100.0000',
      netAmount: '0',
      grossAmount: '0',
      taxRate: 18,
      sourceType: 'purchase',
      accountCode: '2210',
      periodMonth: 1,
      periodYear: 2026,
      date: new Date('2026-01-10'),
      status: 'posted',
      metadata: {},
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    expect(api.period).toEqual({ month: 1, year: 2026 });
    expect(api.isVAT).toBe(true);
    expect(api.isPayroll).toBe(false);
    expect(api.amount).toBe(100);
  });
});

describe('TaxTransactionService.processJournalEntry', () => {
  const baseEntry = {
    _id: '507f1f77bcf86cd799439099',
    entryNumber: 'JE-2026-0001',
    date: new Date('2026-03-01'),
    description: 'Test sale',
    sourceType: 'invoice',
    lines: [
      { accountCode: '4000', debit: 0, credit: 1000, description: 'Revenue' },
      { accountCode: '2220', debit: 0, credit: 180, description: 'VAT output' },
    ],
  };

  test('builds vat_output row from credit on 2220', () => {
    const docs = [];
    const originalInsert = require('../models/TaxTransaction').insertMany;
    require('../models/TaxTransaction').insertMany = jest.fn(async (rows) => {
      docs.push(...rows);
      return rows;
    });

    return TaxTransactionService.processJournalEntry(baseEntry, {
      companyId: '507f1f77bcf86cd799439012',
      userId: '507f1f77bcf86cd799439013',
      sourceType: 'invoice',
    }).then((created) => {
      expect(created).toHaveLength(1);
      expect(docs[0].taxType).toBe('vat_output');
      expect(docs[0].direction).toBe('output');
      expect(docs[0].amount).toBe(180);
      expect(docs[0].accountCode).toBe('2220');
    }).finally(() => {
      require('../models/TaxTransaction').insertMany = originalInsert;
    });
  });

  test('returns empty array when no tax lines', async () => {
    const result = await TaxTransactionService.processJournalEntry(
      { ...baseEntry, lines: [{ accountCode: '4000', debit: 0, credit: 100 }] },
      { companyId: '507f1f77bcf86cd799439012' },
    );
    expect(result).toEqual([]);
  });
});
