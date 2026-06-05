const EBMPurchaseService = require('../services/ebmPurchaseService');

describe('EBM purchase confirmation payload', () => {
  it('includes RRA VSDC required purchase totals, tax buckets, and audit fields', () => {
    const payload = EBMPurchaseService.__test__.buildPurchaseConfirmationPayload(
      {
        company: 'company-1',
        referenceNo: 'PO-1001',
        purchaseDate: new Date('2026-06-04T10:00:00Z'),
        ebm: {
          ebmPurchaseSalesInvcNo: '77',
          prcOrdCd: 'ABCDE1',
          ebmPurchaseData: {
            spplrTin: '999999999',
            spplrNm: 'Supplier Name',
            spplrBhfId: '00',
            pchsDt: '20260604',
            itemList: [
              {
                itemSeq: 1,
                itemCd: 'RW1NTXU0000001',
                itemClsCd: '5059690800',
                itemNm: 'Standard VAT Item',
                bcd: '123456789012345678901',
                pkgUnitCd: 'NI',
                pkg: 10,
                qtyUnitCd: 'U',
                qty: 10,
                prc: 3500,
                splyAmt: 35000,
                dcRt: 2,
                dcAmt: 700,
                taxTyCd: 'B',
                taxblAmt: 35000,
                taxAmt: 6300,
                totAmt: 41300,
                itemExprDt: '20261231',
              },
              {
                itemSeq: 2,
                itemCd: 'RW1NTXU0000002',
                itemClsCd: '5059690800',
                itemNm: 'Exempt Item',
                pkgUnitCd: 'NI',
                qtyUnitCd: 'U',
                qty: 1,
                prc: 5000,
                splyAmt: 5000,
                taxTyCd: 'A',
                taxblAmt: 5000,
                taxAmt: 0,
                totAmt: 5000,
              },
            ],
          },
        },
      },
      {
        name: 'Buyer Company',
        tax_identification_number: '999991130',
      },
      '00',
    );

    expect(payload).toMatchObject({
      tin: '999991130',
      bhfId: '00',
      invcNo: '77',
      spplrTin: '999999999',
      spplrNm: 'Supplier Name',
      spplrBhfId: '00',
      prcOrdCd: 'ABCDE',
      pchsSttsCd: '02',
      pchsDt: '20260604',
      totItemCnt: 2,
      taxblAmtA: 5000,
      taxblAmtB: 35000,
      taxblAmtC: 0,
      taxblAmtD: 0,
      taxRtA: 0,
      taxRtB: 0,
      taxRtC: 0,
      taxRtD: 0,
      taxAmtA: 0,
      taxAmtB: 6300,
      taxAmtC: 0,
      taxAmtD: 0,
      totTaxblAmt: 40000,
      totTaxAmt: 6300,
      totAmt: 46300,
      regrId: '999991130',
      regrNm: 'Buyer Company',
      modrId: '999991130',
      modrNm: 'Buyer Company',
    });
    expect(payload.cfmDt).toMatch(/^\d{14}$/);
    expect(payload.itemList[0]).toMatchObject({
      bcd: '12345678901234567890',
      dcRt: 2,
      dcAmt: 700,
      itemExprDt: '20261231',
    });
    expect(payload.itemList[1]).toMatchObject({
      dcRt: 0,
      dcAmt: 0,
      itemExprDt: null,
    });
  });
});
