jest.mock('../models/DeferredRevenue', () => ({
  find: jest.fn(),
  findOne: jest.fn(),
}));

jest.mock('../services/journalService', () => ({
  createDebitLine: jest.fn(),
  createCreditLine: jest.fn(),
  createEntry: jest.fn(),
}));

jest.mock('../services/sequenceService', () => ({
  nextSequence: jest.fn(),
}));

jest.mock('../models/BankAccount', () => ({
  BankAccount: {},
}));

const DeferredRevenue = require('../models/DeferredRevenue');
const DeferredRevenueService = require('../services/deferredRevenueService');

describe('DeferredRevenueService', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  test('posts scheduled recognitions whose date has arrived', async () => {
    const item = {
      _id: 'deferred-id',
      company: 'company-id',
      createdBy: 'creator-id',
      referenceNo: 'DR-1',
      status: 'active',
      totalAmount: 200,
      totalRecognized: 0,
      remainingBalance: 200,
      recognitions: [
        { _id: 'due-id', amount: 100, date: '2026-10-07T00:00:00.000Z', status: 'pending' },
        { _id: 'future-id', amount: 100, date: '2026-10-09T00:00:00.000Z', status: 'pending' },
        { _id: 'reversed-id', amount: 0, date: '2026-10-07T00:00:00.000Z', status: 'reversed' },
      ],
      save: jest.fn().mockResolvedValue(undefined),
    };
    DeferredRevenue.find.mockReturnValue({
      sort: jest.fn().mockResolvedValue([item]),
    });
    DeferredRevenue.findOne.mockResolvedValue(item);
    jest.spyOn(DeferredRevenueService, '_postRecognitionJournal').mockResolvedValue({ _id: 'journal-id' });

    const result = await DeferredRevenueService.postDueRecognitions(new Date('2026-10-08T00:00:00.000Z'));

    expect(result).toEqual({ posted: 1, failed: 0 });
    expect(item.recognitions[0]).toMatchObject({ status: 'posted', journalEntryId: 'journal-id' });
    expect(item.recognitions[1].status).toBe('pending');
    expect(item.recognitions[2].status).toBe('reversed');
    expect(item.totalRecognized).toBe(100);
    expect(item.remainingBalance).toBe(100);
    expect(item.save).toHaveBeenCalledTimes(1);
  });

  test('populates journal entries attached to recognition schedule rows', async () => {
    const rows = [{ _id: 'deferred-id', recognitions: [] }];
    const query = {
      sort: jest.fn().mockReturnThis(),
      populate: jest.fn().mockReturnThis(),
      then: (resolve, reject) => Promise.resolve(rows).then(resolve, reject),
    };
    DeferredRevenue.find.mockReturnValue(query);

    await DeferredRevenueService.getAll('company-id');

    expect(query.populate).toHaveBeenCalledWith(
      'recognitions.journalEntryId',
      'entryNumber date status',
    );
  });
});
