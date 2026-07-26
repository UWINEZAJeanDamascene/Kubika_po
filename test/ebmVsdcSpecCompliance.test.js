jest.mock('../services/ebmDeviceService', () => ({
  ensureInitialized: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../services/ebmBranchService', () => ({
  ensureBranchRegistered: jest.fn().mockResolvedValue(undefined),
}));

process.env.EBM_MODE = 'mock';

const ebmService = require('../services/ebmService');
const {
  VSDC_ENDPOINTS,
  isRetryableResultCode,
  EBM_MODES,
} = require('../services/ebmService');
const { sanitizeForEndpoint, mapVsdcErrorCode } = require('../utils/vsdcPayloadSanitizer');

const BASE = Object.freeze({
  companyId: 'spec-test-company',
  tin: '999991130',
  bhfId: '00',
  lastReqDt: '20000101000000',
});

const SPEC_V1_0_5_FUNCTIONS = Object.freeze([
  {
    number: 1,
    name: 'Initialize Device',
    path: '/initializer/selectInitInfo',
    method: 'initializeDevice',
    payload: { tin: BASE.tin, bhfId: BASE.bhfId, dvcSrlNo: 'SNCTEQT00001' },
    skipCompany: true,
  },
  {
    number: 2,
    name: 'Select Code List',
    path: '/code/selectCodes',
    method: 'selectCodes',
    payload: BASE,
  },
  {
    number: 3,
    name: 'Search Customer',
    path: '/customers/selectCustomer',
    method: 'selectCustomer',
    payload: { ...BASE, custmTin: '100000003' },
  },
  {
    number: 4,
    name: 'Search Branch',
    path: '/branches/selectBranches',
    method: 'selectBranches',
    payload: BASE,
  },
  {
    number: 5,
    name: 'Save Branch User',
    path: '/branches/saveBranchUser',
    method: 'saveBranchUser',
    payload: { ...BASE, userId: 'admin', userNm: 'Admin', adrs: 'KG 4 Ave 8' },
  },
  {
    number: 6,
    name: 'Save Branch Customer',
    path: '/branches/saveBranchCustomer',
    method: 'saveBranchCustomer',
    payload: { ...BASE, custTin: '100000003', custNm: 'ACME Rwanda Ltd' },
  },
  {
    number: 7,
    name: 'Save Branch Insurance',
    path: '/branches/saveBranchInsurance',
    method: 'saveBranchInsurance',
    payload: { ...BASE, isrccCd: '01', isrccNm: 'Mock Insurance' },
  },
  {
    number: 8,
    name: 'Select Items',
    path: '/items/selectItems',
    method: 'selectItems',
    payload: BASE,
    assert: (response) => expect(Array.isArray(response.data?.itemList)).toBe(true),
  },
  {
    number: 9,
    name: 'Save Item',
    path: '/items/saveItems',
    method: 'saveItems',
    payload: {
      ...BASE,
      itemCd: 'RW1MOCK000000001',
      itemClsCd: '5059690800',
      itemNm: 'Spec item',
      taxTyCd: 'B',
      pkgUnitCd: 'NT',
      qtyUnitCd: 'U',
    },
  },
  {
    number: 10,
    name: 'Select Import Items',
    path: '/imports/selectImportItems',
    method: 'selectImportItems',
    payload: BASE,
    assert: (response) => expect(Array.isArray(response.data?.itemList)).toBe(true),
  },
  {
    number: 11,
    name: 'Save Import Item',
    path: '/imports/saveImportItems',
    method: 'saveImportItems',
    payload: {
      ...BASE,
      taskCd: 'TASK001',
      dclNo: 'DCL001',
      itemSeq: 1,
      itemCd: 'RW1MOCK000000001',
      itemClsCd: '5059690800',
      itemNm: 'Import item',
      qty: 1,
      totAmt: 1000,
    },
  },
  {
    number: 12,
    name: 'Select Sales',
    path: '/transactions/selectTrnsSalesSummary',
    method: 'selectSales',
    payload: BASE,
    assert: (response) => expect(Array.isArray(response.data?.saleList)).toBe(true),
  },
  {
    number: 13,
    name: 'Save Sales',
    path: '/transactions/saveSales',
    method: 'saveSales',
    payload: {
      ...BASE,
      invcNo: 1001,
      salesTyCd: 'N',
      rcptTyCd: 'S',
      salesSttsCd: '02',
      cfmDt: '20260604120000',
      salesDt: '20260604',
      prchrAcptcYn: 'N',
      totItemCnt: 1,
      taxblAmtA: 0,
      taxblAmtB: 1000,
      taxblAmtC: 0,
      taxblAmtD: 0,
      taxRtA: 0,
      taxRtB: 18,
      taxRtC: 0,
      taxRtD: 0,
      taxAmtA: 0,
      taxAmtB: 180,
      taxAmtC: 0,
      taxAmtD: 0,
      totTaxblAmt: 1000,
      totTaxAmt: 180,
      totAmt: 1180,
      itemList: [{
        itemSeq: 1,
        itemCd: 'RW1MOCK000000001',
        itemClsCd: '5059690800',
        itemNm: 'Mock item',
        pkgUnitCd: 'NT',
        pkg: 1,
        qtyUnitCd: 'U',
        qty: 1,
        prc: 1180,
        splyAmt: 1000,
        taxTyCd: 'B',
        taxblAmt: 1000,
        taxAmt: 180,
        totAmt: 1180,
      }],
      receipt: {
        curRcptNo: 1,
        totRcptNo: 1,
        rptNo: 1,
        prchrAcptcYn: 'N',
        rcptPbctDt: '20260604120000',
        totItemCnt: 1,
      },
      regrId: 'system',
      regrNm: 'System',
      modrId: 'system',
      modrNm: 'System',
    },
  },
  {
    number: 14,
    name: 'Select Purchases',
    path: '/transactions/selectTrnsPurchaseSummary',
    method: 'selectPurchaseSales',
    payload: BASE,
    assert: (response) => expect(Array.isArray(response.data?.saleList)).toBe(true),
  },
  {
    number: 15,
    name: 'Save Purchases',
    path: '/transactions/savePurchases',
    method: 'savePurchases',
    payload: { ...BASE, invcNo: 77, pchsSttsCd: '02', totAmt: 1000 },
  },
  {
    number: 16,
    name: 'Select Stock',
    path: '/stock/selectStockItems',
    method: 'selectStockItems',
    payload: BASE,
    assert: (response) => expect(Array.isArray(response.data?.itemList)).toBe(true),
  },
  {
    number: 17,
    name: 'Save Stock Master',
    path: '/stock/saveStockMaster',
    method: 'saveStockMaster',
    payload: { ...BASE, itemCd: 'RW1MOCK000000001', rsdQty: 10 },
  },
  {
    number: 18,
    name: 'Save Stock In/Out',
    path: '/stock/saveStockItems',
    method: 'saveStockItems',
    payload: {
      ...BASE,
      sarNo: 1,
      sarTyCd: '11',
      totItemCnt: 1,
      totAmt: 1000,
      itemList: [{
        itemSeq: 1,
        itemCd: 'RW1MOCK000000001',
        qty: 1,
        prc: 1000,
        totAmt: 1000,
      }],
    },
  },
]);

describe('RRA VSDC v1.0.5 spec compliance', () => {
  it('defines all 18 official API paths from section 3.2.1', () => {
    const implementedPaths = new Set(Object.values(VSDC_ENDPOINTS));
    SPEC_V1_0_5_FUNCTIONS.forEach((entry) => {
      expect(implementedPaths.has(entry.path)).toBe(true);
      expect(VSDC_ENDPOINTS[Object.keys(VSDC_ENDPOINTS).find((key) => VSDC_ENDPOINTS[key] === entry.path)]).toBe(entry.path);
    });
    expect(SPEC_V1_0_5_FUNCTIONS).toHaveLength(18);
  });

  it.each(SPEC_V1_0_5_FUNCTIONS.map((entry) => [entry.number, entry.name, entry.method]))(
    'mock mode succeeds for #%i %s via %s',
    async (_number, _name, method) => {
      const entry = SPEC_V1_0_5_FUNCTIONS.find((item) => item.method === method);
      const payload = entry.skipCompany
        ? entry.payload
        : { ...entry.payload, companyId: BASE.companyId };

      const response = await ebmService[method](payload);
      expect(response.resultCd).toBe('000');
      if (entry.assert) entry.assert(response);
    },
  );

  it('strips internal CIS fields before wire transport for saveSales', () => {
    const sanitized = sanitizeForEndpoint(VSDC_ENDPOINTS.SAVE_SALES, {
      companyId: 'internal',
      branchId: '00',
      orgRcptNo: '99',
      invcNo: '42',
      totAmt: '100',
    });

    expect(sanitized).not.toHaveProperty('companyId');
    expect(sanitized).not.toHaveProperty('branchId');
    expect(sanitized).not.toHaveProperty('orgRcptNo');
    expect(sanitized.invcNo).toBe(42);
    expect(sanitized.totAmt).toBe(100);
  });

  it('treats v1.0.5 purchase and TIN rejection codes as non-retryable', () => {
    ['881', '882', '883', '884'].forEach((code) => {
      expect(isRetryableResultCode(code)).toBe(false);
      expect(mapVsdcErrorCode(code)).toBeTruthy();
    });
  });

  it('treats transient VSDC errors as retryable', () => {
    ['005', '006', '811', '999'].forEach((code) => {
      expect(isRetryableResultCode(code)).toBe(true);
    });
  });

  it('supports mock, sandbox, and production modes', () => {
    expect(Object.values(EBM_MODES)).toEqual(['mock', 'sandbox', 'production']);
  });
});
