jest.mock('../models/Loan', () => ({
  findOne: jest.fn(),
  findByIdAndUpdate: jest.fn(),
}));
jest.mock('../utils/pagination', () => ({}));
jest.mock('../services/journalService', () => ({}));
jest.mock('../models/ChartOfAccount', () => ({ findOne: jest.fn() }));
jest.mock('../models/BankAccount', () => ({ BankAccount: {} }));
jest.mock('../models/JournalEntry', () => ({}));
jest.mock('../services/sequenceService', () => ({}));
jest.mock('../services/periodService', () => ({}));
jest.mock('../constants/chartOfAccounts', () => ({
  CHART_OF_ACCOUNTS: {},
  DEFAULT_ACCOUNTS: {},
}));

const Loan = require('../models/Loan');
const { updateLoan } = require('../controllers/loanController');

function makeResponse() {
  return {
    status: jest.fn().mockReturnThis(),
    json: jest.fn(),
  };
}

function makeLoan(transactions = [{ type: 'drawdown' }]) {
  return {
    _id: 'loan-1',
    company: 'company-1',
    originalAmount: 1000,
    interestRate: 7,
    interestMethod: 'simple',
    durationMonths: 3,
    startDate: new Date('2026-09-29T00:00:00.000Z'),
    transactions,
    payments: [],
    amountPaid: 0,
  };
}

describe('loan update with funding transactions', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    Loan.findByIdAndUpdate.mockImplementation(async (id, update) => ({
      ...makeLoan(),
      ...update,
    }));
  });

  test('allows schedule and IFRS 9 edits after initial drawdown and recalculates payment', async () => {
    Loan.findOne.mockResolvedValue(makeLoan());
    const response = makeResponse();

    await updateLoan(
      {
        params: { id: 'loan-1' },
        user: { company: { _id: 'company-1' } },
        body: {
          interestRate: 0,
          interestMethod: 'simple',
          durationMonths: 3,
          ifrs9Classification: 'amortized_cost',
          impairmentStage: 'stage_1',
          eclProvision: 0,
          probabilityOfDefault: 0,
          lossGivenDefault: 45,
          exposureAtDefault: 1000,
          effectiveInterestRate: 0,
          significantIncreaseInCreditRisk: false,
          daysPastDue: 0,
          forbearanceStatus: 'none',
        },
      },
      response,
      jest.fn(),
    );

    expect(Loan.findByIdAndUpdate).toHaveBeenCalledWith(
      'loan-1',
      expect.objectContaining({ interestRate: 0, monthlyPayment: 333.33 }),
      { new: true, runValidators: true },
    );
    expect(response.status).not.toHaveBeenCalled();
    expect(response.json).toHaveBeenCalledWith({
      success: true,
      data: expect.objectContaining({ interestRate: 0 }),
    });
  });

  test('continues to reject schedule edits after repayments or interest charges', async () => {
    Loan.findOne.mockResolvedValue(
      makeLoan([{ type: 'drawdown' }, { type: 'repayment', amount: 100 }]),
    );
    const response = makeResponse();

    await updateLoan(
      {
        params: { id: 'loan-1' },
        user: { company: { _id: 'company-1' } },
        body: { interestRate: 0 },
      },
      response,
      jest.fn(),
    );

    expect(response.status).toHaveBeenCalledWith(400);
    expect(Loan.findByIdAndUpdate).not.toHaveBeenCalled();
  });

  test('accepts IFRS 9 disclosure edits after repayments', async () => {
    Loan.findOne.mockResolvedValue(
      makeLoan([{ type: 'drawdown' }, { type: 'repayment', amount: 100 }]),
    );
    const response = makeResponse();

    await updateLoan(
      {
        params: { id: 'loan-1' },
        user: { company: { _id: 'company-1' } },
        body: { impairmentStage: 'stage_1', eclProvision: 0 },
      },
      response,
      jest.fn(),
    );

    expect(Loan.findByIdAndUpdate).toHaveBeenCalledWith(
      'loan-1',
      expect.objectContaining({ impairmentStage: 'stage_1', eclProvision: 0 }),
      { new: true, runValidators: true },
    );
  });
});