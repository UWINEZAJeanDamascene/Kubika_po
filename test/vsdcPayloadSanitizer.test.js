const { VSDC_ENDPOINTS } = require('../services/ebmService');
const {
  sanitizeForEndpoint,
  extractInitInfo,
  extractSaveSalesFiscalData,
  mapVsdcErrorCode,
} = require('../utils/vsdcPayloadSanitizer');

describe('VSDC payload sanitizer', () => {
  it('strips internal fields and non-spec sales fields before wire transport', () => {
    const sanitized = sanitizeForEndpoint(VSDC_ENDPOINTS.SAVE_SALES, {
      companyId: 'company-1',
      branchId: '00',
      tin: '999991130',
      bhfId: '00',
      invcNo: '1001',
      orgRcptNo: '55',
      totItemCnt: '1',
      totAmt: '1180',
      itemList: [{ itemSeq: '1', qty: '2', totAmt: '1180' }],
      receipt: { curRcptNo: '10', totRcptNo: '10', rptNo: '3', totItemCnt: '1' },
    });

    expect(sanitized).not.toHaveProperty('companyId');
    expect(sanitized).not.toHaveProperty('branchId');
    expect(sanitized).not.toHaveProperty('orgRcptNo');
    expect(sanitized.invcNo).toBe(1001);
    expect(sanitized.totItemCnt).toBe(1);
    expect(sanitized.totAmt).toBe(1180);
    expect(sanitized.itemList[0].qty).toBe(2);
    expect(sanitized.receipt.curRcptNo).toBe(10);
  });

  it('strips purchase-only fields from savePurchases payloads', () => {
    const sanitized = sanitizeForEndpoint(VSDC_ENDPOINTS.SAVE_PURCHASES, {
      companyId: 'company-1',
      tin: '999991130',
      bhfId: '00',
      spplrInvcNo: 'SUP-001',
      invcNo: '12',
      totAmt: '1000',
    });

    expect(sanitized).not.toHaveProperty('spplrInvcNo');
    expect(sanitized.invcNo).toBe(12);
  });

  it('extracts init info from flat or nested mock responses', () => {
    expect(extractInitInfo({ tin: '999991130', lastSaleInvcNo: 5 })).toMatchObject({ tin: '999991130', lastSaleInvcNo: 5 });
    expect(extractInitInfo({ info: { tin: '999991130', lastSaleInvcNo: 5 } })).toMatchObject({ tin: '999991130', lastSaleInvcNo: 5 });
  });

  it('extracts fiscal data from nested saveSales responses', () => {
    const fiscal = extractSaveSalesFiscalData({
      resultDt: '20260604120000',
      data: {
        rcptSign: 'SIGN',
        intrlData: 'INTERNAL',
        rcptNo: 42,
        rcptDt: '20260604120000',
        sdcId: 'SDC0000001',
      },
    });

    expect(fiscal).toMatchObject({
      rcptSign: 'SIGN',
      intrlData: 'INTERNAL',
      rcptNo: 42,
      sdcId: 'SDC0000001',
    });
  });

  it('maps v1.0.5 purchase and TIN rejection codes', () => {
    expect(mapVsdcErrorCode('881')).toMatch(/Purchase confirmation is mandatory/i);
    expect(mapVsdcErrorCode('884')).toMatch(/Customer TIN is invalid/i);
  });
});
