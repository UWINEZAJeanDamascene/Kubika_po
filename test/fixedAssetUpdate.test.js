jest.mock('../models/FixedAsset', () => ({
  FixedAsset: { findOne: jest.fn() },
  DepreciationEntry: { countDocuments: jest.fn() },
}));
jest.mock('../models/AssetDisposalEvent', () => ({}));
jest.mock('../models/AssetStatusHistory', () => ({}));
jest.mock('../models/JournalEntry', () => ({ findOne: jest.fn() }));
jest.mock('../models/ChartOfAccount', () => ({}));
jest.mock('../constants/chartOfAccounts', () => ({
  canPostToAccount: jest.fn(),
  DEFAULT_ACCOUNTS: {},
  CHART_OF_ACCOUNTS: {},
}));
jest.mock('../services/periodService', () => ({}));
jest.mock('../models/BankAccount', () => ({ BankAccount: {} }));
jest.mock('../services/journalService', () => ({ createEntry: jest.fn() }));
jest.mock('../services/transactionService', () => ({
  runInPrismaTransaction: jest.fn((operation) => operation({})),
}));

const mongoose = require('mongoose');
const { FixedAsset, DepreciationEntry } = require('../models/FixedAsset');
const JournalEntry = require('../models/JournalEntry');
const JournalService = require('../services/journalService');
const { runInPrismaTransaction } = require('../services/transactionService');
const { updateAsset } = require('../controllers/fixedAssetController');

function decimal(value) {
  return mongoose.Types.Decimal128.fromString(String(value));
}

function makeResponse() {
  return {
    status: jest.fn().mockReturnThis(),
    json: jest.fn(),
  };
}

function makeAsset() {
  return {
    _id: 'asset-1',
    company: 'company-1',
    name: 'DEMO TEST - Office Laptop',
    referenceNo: 'AST-2026-00001',
    assetAccountCode: '1710',
    purchaseCost: decimal(1),
    salvageValue: decimal(0),
    accumulatedDepreciation: decimal(0),
    netBookValue: decimal(1),
    save: jest.fn().mockResolvedValue(undefined),
  };
}

describe('fixed asset purchase-cost updates', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    DepreciationEntry.countDocuments.mockResolvedValue(0);
    JournalService.createEntry.mockResolvedValue({ _id: 'adjustment-1' });
  });

  test('persists the new cost and posts a balanced adjustment in one transaction', async () => {
    const asset = makeAsset();
    FixedAsset.findOne.mockResolvedValue(asset);
    JournalEntry.findOne.mockResolvedValue({
      status: 'posted',
      reversed: false,
      lines: [
        { accountCode: '1710', accountName: 'Computers', debit: 1, credit: 0 },
        { accountCode: '2000', accountName: 'Accounts Payable', debit: 0, credit: 1 },
      ],
    });
    const response = makeResponse();

    await updateAsset(
      {
        params: { id: 'asset-1' },
        user: { _id: 'user-1', company: { _id: 'company-1' } },
        body: { purchaseCost: 1000000 },
      },
      response,
    );

    expect(runInPrismaTransaction).toHaveBeenCalledTimes(1);
    expect(JournalService.createEntry).toHaveBeenCalledWith(
      'company-1',
      'user-1',
      expect.objectContaining({
        sourceType: 'asset_purchase_adjustment',
        lines: [
          expect.objectContaining({ accountCode: '1710', debit: 999999, credit: 0 }),
          expect.objectContaining({ accountCode: '2000', debit: 0, credit: 999999 }),
        ],
      }),
    );
    expect(Number(asset.purchaseCost.toString())).toBe(1000000);
    expect(Number(asset.netBookValue.toString())).toBe(1000000);
    expect(asset.save).toHaveBeenCalledTimes(1);
    expect(response.json).toHaveBeenCalledWith({ success: true, data: asset });
  });

  test('does not change the asset when its original purchase journal is missing', async () => {
    const asset = makeAsset();
    FixedAsset.findOne.mockResolvedValue(asset);
    JournalEntry.findOne.mockResolvedValue(null);
    const response = makeResponse();

    await updateAsset(
      {
        params: { id: 'asset-1' },
        user: { _id: 'user-1', company: { _id: 'company-1' } },
        body: { purchaseCost: 1000000 },
      },
      response,
    );

    expect(response.status).toHaveBeenCalledWith(409);
    expect(asset.save).not.toHaveBeenCalled();
    expect(JournalService.createEntry).not.toHaveBeenCalled();
  });
});