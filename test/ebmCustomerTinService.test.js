jest.mock('../models/Company', () => ({ findById: jest.fn() }));
jest.mock('../models/Warehouse', () => ({ findOne: jest.fn() }));
jest.mock('../models/Client', () => ({ findOne: jest.fn(), updateOne: jest.fn() }));
jest.mock('../models/Invoice', () => ({ findOne: jest.fn() }));
jest.mock('../models/EBMTIN', () => ({ findOneAndUpdate: jest.fn() }));
jest.mock('../services/ebmService', () => ({ selectCustomer: jest.fn() }));

const Company = require('../models/Company');
const Warehouse = require('../models/Warehouse');
const EBMTIN = require('../models/EBMTIN');
const ebmService = require('../services/ebmService');
const EBMTinService = require('../services/ebmCustomerTinService');

const leanResult = (value) => ({ lean: jest.fn().mockResolvedValue(value) });

beforeEach(() => {
  jest.clearAllMocks();
  Company.findById.mockReturnValue(leanResult({
    _id: 'company-1',
    tax_identification_number: '999991130',
  }));
  Warehouse.findOne.mockReturnValue(leanResult({
    _id: 'warehouse-1',
    rraBranchId: '00',
  }));
  EBMTIN.findOneAndUpdate.mockResolvedValue({});
  ebmService.selectCustomer.mockResolvedValue({
    resultCd: '000',
    resultMsg: 'Successful',
    resultDt: '20260705120000',
    data: {
      custList: [
        {
          custTin: '100000003',
          custNm: 'ACME Rwanda Ltd',
          custBhfSttsCd: '01',
          prvncNm: 'Kigali',
          dstrtNm: 'Gasabo',
        },
      ],
    },
  });
});

describe('EBM customer TIN verification', () => {
  it('builds the RRA VSDC selectCustomer payload with company TIN and customer TIN separated', async () => {
    const verification = await EBMTinService.verifyTin('company-1', '100-000-003', { branchId: '00' });

    expect(ebmService.selectCustomer).toHaveBeenCalledWith(expect.objectContaining({
      companyId: 'company-1',
      tin: '999991130',
      bhfId: '00',
      custmTin: '100000003',
      lastReqDt: '20000101000000',
    }));
    expect(verification).toEqual(expect.objectContaining({
      tin: '100000003',
      branchId: '00',
      status: 'valid',
      taxpayerName: 'ACME Rwanda Ltd',
      resultCd: '000',
    }));
    expect(EBMTIN.findOneAndUpdate).toHaveBeenCalledWith(
      { tin: '100000003' },
      { $set: expect.objectContaining({ taxpayerName: 'ACME Rwanda Ltd', active: true }) },
      { upsert: true, new: true },
    );
  });

  it('rejects invalid customer TIN before calling VSDC', async () => {
    await expect(EBMTinService.verifyTin('company-1', '12345', { branchId: '00' }))
      .rejects.toMatchObject({ code: 'EBM_CUSTOMER_TIN_INVALID_FORMAT', retryable: false });

    expect(ebmService.selectCustomer).not.toHaveBeenCalled();
  });
});