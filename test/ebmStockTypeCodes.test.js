const {
  EBM_STOCK_TYPE_CODES,
  getAdjustmentCode,
} = require('../constants/ebmStockTypeCodes');

describe('EBM stock type codes', () => {
  it('matches RRA VSDC v1.0.5 stock in/out code table', () => {
    expect(EBM_STOCK_TYPE_CODES).toMatchObject({
      IMPORT_CONFIRMED_STOCK_IN: '01',
      GRN_PURCHASE_RECEIPT: '01',
      CUSTOMER_RETURN_IN: '02',
      BRANCH_TRANSFER_IN: '04',
      STOCK_ADJUSTMENT_IN: '04',
      SALE_OUT: '11',
      SUPPLIER_RETURN_OUT: '12',
      BRANCH_TRANSFER_OUT: '14',
      STOCK_ADJUSTMENT_OUT: '13',
      OPENING_STOCK: '04',
    });

    expect(new Set(Object.values(EBM_STOCK_TYPE_CODES))).toEqual(
      new Set(['01', '02', '04', '11', '12', '13', '14']),
    );
  });

  it('uses spec adjustment codes for stock adjustments', () => {
    expect(getAdjustmentCode('in')).toBe('04');
    expect(getAdjustmentCode('out')).toBe('13');
  });
});
