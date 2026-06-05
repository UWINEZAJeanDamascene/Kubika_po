const { VSDC_ENDPOINTS } = require('../services/ebmService');
const { normalizeQueueEndpoint, normalizeQueuePayload } = require('../services/ebmRetryJob');

describe('EBM VSDC endpoint constants', () => {
  it('uses RRA VSDC v1.0.5 paths for transaction and stock submissions', () => {
    expect(VSDC_ENDPOINTS.SAVE_SALES).toBe('/transactions/saveSales');
    expect(VSDC_ENDPOINTS.SELECT_PURCHASE_SALES).toBe('/transactions/selectTrnsPurchaseSummary');
    expect(VSDC_ENDPOINTS.SAVE_PURCHASES).toBe('/transactions/savePurchases');
    expect(VSDC_ENDPOINTS.SAVE_STOCK_MASTER).toBe('/stock/saveStockMaster');
  });

  it('normalizes legacy queued VSDC paths before retrying submissions', () => {
    expect(normalizeQueueEndpoint('/trnsSales/saveSales')).toBe(VSDC_ENDPOINTS.SAVE_SALES);
    expect(normalizeQueueEndpoint('/trnsPurchase/selectTrnsPurchaseSales')).toBe(VSDC_ENDPOINTS.SELECT_PURCHASE_SALES);
    expect(normalizeQueueEndpoint('/trnsPurchase/savePurchases')).toBe(VSDC_ENDPOINTS.SAVE_PURCHASES);
    expect(normalizeQueueEndpoint('/stockMaster/saveStockMaster')).toBe(VSDC_ENDPOINTS.SAVE_STOCK_MASTER);
    expect(normalizeQueueEndpoint('/stock/saveStockItems')).toBe('/stock/saveStockItems');
  });

  it('normalizes legacy queued sales status payload fields before retrying submissions', () => {
    const normalized = normalizeQueuePayload(VSDC_ENDPOINTS.SAVE_SALES, {
      invcNo: '1',
      invcSttsCd: '02',
      salesDt: '20260604123456',
    });

    expect(normalized).toEqual({
      invcNo: '1',
      salesSttsCd: '02',
      salesDt: '20260604',
    });
    expect(normalized).not.toHaveProperty('invcSttsCd');
  });

  it('leaves current queued sales status and date payload fields unchanged', () => {
    const payload = { invcNo: '1', salesSttsCd: '02' };

    expect(normalizeQueuePayload(VSDC_ENDPOINTS.SAVE_SALES, payload)).toBe(payload);
  });
});
