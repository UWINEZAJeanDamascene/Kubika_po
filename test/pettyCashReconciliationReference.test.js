jest.mock('../services/sequenceService', () => ({
  nextSequence: jest.fn().mockResolvedValue(7),
}));

const { nextSequence } = require('../services/sequenceService');
const {
  pettyCashReconciliationTranslateCreate,
} = require('../utils/bankingMappers');

describe('petty cash reconciliation reference', () => {
  afterEach(() => jest.clearAllMocks());

  test('generates a required reference when creating a cash count', async () => {
    const companyId = 'company-id';
    const result = await pettyCashReconciliationTranslateCreate({
      company: companyId,
      float: 'float-id',
      countedBy: 'user-id',
      countDate: '2026-10-08',
      systemBalance: 100,
      physicalCashTotal: 100,
      difference: 0,
      differenceType: 'balanced',
      cashDenominations: [],
    });

    expect(nextSequence).toHaveBeenCalledWith(
      companyId,
      'petty_cash_reconciliation',
      { year: new Date().getFullYear() },
    );
    expect(result).toMatchObject({
      companyId,
      floatId: 'float-id',
      countedById: 'user-id',
      reconciliationNumber: `PCR-${new Date().getFullYear()}-7`,
    });
  });
});
