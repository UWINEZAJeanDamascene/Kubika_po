const { systemRoles } = require('../scripts/seedSystemRoles');

describe('system role permissions', () => {
  test.each(['manager', 'purchaser'])('%s can approve purchase orders', (roleName) => {
    const role = systemRoles.find(({ name }) => name === roleName);
    const purchaseOrderPermission = role?.permissions.find(
      ({ resource }) => resource === 'purchase_orders',
    );

    expect(purchaseOrderPermission?.actions).toContain('approve');
  });

  test('viewer cannot approve purchase orders', () => {
    const viewerRole = systemRoles.find(({ name }) => name === 'viewer');
    const purchaseOrderPermission = viewerRole?.permissions.find(
      ({ resource }) => resource === 'purchase_orders',
    );

    expect(purchaseOrderPermission?.actions).not.toContain('approve');
  });
});
