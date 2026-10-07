jest.mock('../models/FreightBill', () => ({
  find: jest.fn(),
  countDocuments: jest.fn(),
}));
jest.mock('../models/GoodsReceivedNote', () => ({}));
jest.mock('../services/journalService', () => ({}));
jest.mock('../services/transactionService', () => ({}));

const FreightBill = require('../models/FreightBill');
const { listFreightBills } = require('../controllers/freightBillController');

function makeResponse() {
  return {
    status: jest.fn().mockReturnThis(),
    json: jest.fn(),
  };
}

function makeFindQuery(rows) {
  const query = {
    populate: jest.fn(),
    sort: jest.fn(),
    skip: jest.fn(),
    limit: jest.fn(),
    lean: jest.fn().mockResolvedValue(rows),
  };
  for (const method of ['populate', 'sort', 'skip', 'limit']) {
    query[method].mockReturnValue(query);
  }
  return query;
}

describe('freight bill list tenant resolution', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('lists bills when company context is an id string', async () => {
    const bill = { _id: 'bill-1', referenceNo: 'FB-001' };
    FreightBill.find.mockReturnValue(makeFindQuery([bill]));
    FreightBill.countDocuments.mockResolvedValue(1);
    const res = makeResponse();

    await listFreightBills(
      { user: { company: 'company-1' }, query: {} },
      res,
      jest.fn(),
    );

    expect(FreightBill.find).toHaveBeenCalledWith({ company: 'company-1' });
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ data: [bill] }));
  });

  test('uses company context from the request when the user has no company', async () => {
    FreightBill.find.mockReturnValue(makeFindQuery([]));
    FreightBill.countDocuments.mockResolvedValue(0);
    const res = makeResponse();

    await listFreightBills(
      { company: { id: 'company-2' }, user: {}, query: {} },
      res,
      jest.fn(),
    );

    expect(FreightBill.find).toHaveBeenCalledWith({ company: 'company-2' });
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ data: [] }));
  });
});
