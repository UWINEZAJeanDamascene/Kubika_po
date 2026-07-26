const { EBM_SYNC_TYPES, EBM_CODE_SYNC_TYPES } = require('../constants/ebmSyncTypes');

describe('EBM sync type constants', () => {
  // Postgres stores sync_type as a plain string, so these constants are the only
  // guard against a service persisting a type the readers don't look up.
  it('defines the sync types persisted by the EBM sync services', () => {
    expect(Object.values(EBM_SYNC_TYPES)).toEqual(expect.arrayContaining([
      EBM_SYNC_TYPES.SALES_SUMMARY,
      EBM_SYNC_TYPES.REGISTERED_ITEMS,
      EBM_SYNC_TYPES.PURCHASE_SALES,
      EBM_SYNC_TYPES.IMPORTED_ITEMS,
    ]));
  });

  it('limits the code sync batch to the RRA reference-data types', () => {
    expect(EBM_CODE_SYNC_TYPES).toEqual([
      EBM_SYNC_TYPES.STANDARD_CODES,
      EBM_SYNC_TYPES.ITEM_CLASSES,
      EBM_SYNC_TYPES.TINS,
      EBM_SYNC_TYPES.BRANCHES,
      EBM_SYNC_TYPES.NOTICES,
    ]);
  });
});
