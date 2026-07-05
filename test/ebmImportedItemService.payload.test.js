const EBMImportedItemService = require('../services/ebmImportedItemService');

describe('EBM imported item confirmation payload', () => {
  it('builds RRA VSDC v1.0.5 saveImportItems payload from the synced raw import item', () => {
    const payload = EBMImportedItemService.__test__.buildSaveImportItemPayload(
      {
        company: 'company-1',
        importTaskCode: 'TASK-1',
        importDeclarationNo: 'DCL-1',
        importDate: new Date('2026-07-05T00:00:00Z'),
        itemName: 'Imported Rice',
        quantity: 12,
        unitCode: 'KG',
        originCountryCode: 'TZ',
        supplierName: 'Supplier Ltd',
        raw: {
          taskCd: 'TASK-1',
          dclDe: '20260705',
          itemSeq: 3,
          dclNo: 'DCL-1',
          hsCd: '100630',
          itemNm: 'Imported Rice',
          orgnNatCd: 'TZ',
          qty: 12,
          qtyUnitCd: 'KG',
          spplrNm: 'Supplier Ltd',
        },
      },
      { tin: '999991130' },
      '00',
      { id: 'u-1', name: 'Alice' },
      '2',
    );

    expect(payload).toMatchObject({
      tin: '999991130',
      bhfId: '00',
      taskCd: 'TASK-1',
      dclDe: '20260705',
      itemSeq: 3,
      dclNo: 'DCL-1',
      hsCd: '100630',
      imptItemSttsCd: '2',
      itemNm: 'Imported Rice',
      regrId: 'u-1',
      regrNm: 'Alice',
      modrId: 'u-1',
      modrNm: 'Alice',
      qty: 12,
      qtyUnitCd: 'KG',
      spplrNm: 'Supplier Ltd',
    });
    expect(payload).not.toHaveProperty('itemCd');
  });

  it('rejects confirmation when required RRA fields are missing from the synced record', () => {
    expect(() => EBMImportedItemService.__test__.buildSaveImportItemPayload(
      { company: 'company-1', importTaskCode: 'TASK-1', raw: {} },
      { tin: '999991130' },
      '00',
      { id: 'u-1', name: 'Alice' },
      '2',
    )).toThrow(/missing RRA confirmation fields/i);
  });
});
