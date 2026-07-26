#!/usr/bin/env node
/* eslint-disable no-console */
process.env.EBM_MODE = process.env.EBM_MODE || 'mock';

const EBMDeviceService = require('../services/ebmDeviceService');
const EBMBranchService = require('../services/ebmBranchService');

EBMDeviceService.ensureInitialized = async () => {};
EBMBranchService.ensureBranchRegistered = async () => {};

const ebmService = require('../services/ebmService');
const { VSDC_ENDPOINTS, isRetryableResultCode } = require('../services/ebmService');
const { sanitizeForEndpoint, extractSaveSalesFiscalData } = require('../utils/vsdcPayloadSanitizer');

const BASE = {
  companyId: 'mock-e2e-company',
  tin: '999991130',
  bhfId: '00',
  lastReqDt: '20000101000000',
};

async function runStep(name, fn) {
  process.stdout.write(`- ${name}... `);
  await fn();
  console.log('ok');
}

async function main() {
  console.log(`EBM mock E2E runner (mode=${ebmService.getConfig().mode})`);

  await runStep('initialize device', async () => {
    const response = await ebmService.initializeDevice({
      tin: BASE.tin,
      bhfId: BASE.bhfId,
      dvcSrlNo: 'dvc99999113000',
    });
    if (response.resultCd !== '000') throw new Error(`init failed: ${response.resultMsg}`);
  });

  await runStep('sync codes', async () => {
    const response = await ebmService.selectCodes({ ...BASE });
    if (!response.data?.clsList?.length) throw new Error('code sync returned no classes');
  });

  await runStep('select sales summaries', async () => {
    const response = await ebmService.selectSales({ ...BASE });
    if (!Array.isArray(response.data?.saleList)) throw new Error('sales summary missing saleList');
  });

  await runStep('select registered items', async () => {
    const response = await ebmService.selectItems({ ...BASE });
    if (!Array.isArray(response.data?.itemList)) throw new Error('selectItems missing itemList');
  });

  await runStep('select stock items', async () => {
    const response = await ebmService.selectStockItems({ ...BASE });
    if (!Array.isArray(response.data?.itemList)) throw new Error('stock select missing itemList');
  });

  await runStep('save sales with sanitized payload', async () => {
    const rawPayload = {
      ...BASE,
      invcNo: 1001,
      orgInvcNo: 0,
      salesTyCd: 'N',
      rcptTyCd: 'S',
      pmtTyCd: '01',
      salesSttsCd: '02',
      cfmDt: '20260604120000',
      salesDt: '20260604',
      prchrAcptcYn: 'N',
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
      totItemCnt: 1,
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
    };

    const wirePayload = sanitizeForEndpoint(VSDC_ENDPOINTS.SAVE_SALES, rawPayload);
    if (wirePayload.companyId) throw new Error('companyId was not stripped');
    const response = await ebmService.saveSales(rawPayload);
    const fiscal = extractSaveSalesFiscalData(response);
    if (!fiscal.rcptSign || !fiscal.intrlData) throw new Error('missing fiscal signature data');
  });

  if (!isRetryableResultCode('005')) throw new Error('005 should be retryable');
  if (isRetryableResultCode('884')) throw new Error('884 should not be retryable');

  console.log('All mock E2E checks passed.');
}

main().catch((error) => {
  console.error('\nEBM mock E2E failed:', error.message);
  process.exit(1);
});
