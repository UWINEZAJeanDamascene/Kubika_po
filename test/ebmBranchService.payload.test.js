const { __test__ } = require('../services/ebmBranchService');

const company = {
  _id: 'company-1',
  tax_identification_number: '999991130',
};

const registrar = {
  _id: '64f000000000000000000001',
  name: 'Registrar User With A Very Long Name That Must Be Trimmed By The Builder',
  email: 'registrar@example.com',
};

describe('EBM branch payload builders', () => {
  it('builds a spec-shaped saveBranchUser payload without userList', () => {
    const payload = __test__.buildBranchUserPayload(company, '1', {
      _id: '64f000000000000000000002',
      name: 'Sales User',
      email: 'sales.user@example.com',
      phone: '+250788000000',
    }, registrar);

    expect(payload).toMatchObject({
      tin: '999991130',
      bhfId: '01',
      userNm: 'Sales User',
      pwd: '0000000000',
      regrNm: expect.any(String),
      modrNm: expect.any(String),
    });
    expect(payload).not.toHaveProperty('userList');
    expect(payload.userId.length).toBeLessThanOrEqual(20);
    expect(payload.regrId.length).toBeLessThanOrEqual(20);
    expect(payload.regrNm.length).toBeLessThanOrEqual(60);
  });

  it('builds a spec-shaped saveBranchCustomer payload without branch metadata lists', () => {
    const payload = __test__.buildBranchCustomerPayload(company, '00', {
      _id: '64f000000000000000000003',
      code: 'CLIENT-00000000000000000000001',
      name: 'Kigali Retail Customer',
      taxId: '100600570',
      isActive: true,
      contact: {
        phone: '+250788111222',
        email: 'customer@example.com',
        address: 'Kigali',
        fax: '12345',
      },
    }, registrar);

    expect(payload).toMatchObject({
      tin: '999991130',
      bhfId: '00',
      custTin: '100600570',
      custNm: 'Kigali Retail Customer',
      useYn: 'Y',
    });
    expect(payload.custNo.length).toBeLessThanOrEqual(20);
    expect(payload).not.toHaveProperty('bhfList');
    expect(payload).not.toHaveProperty('userList');
  });
});
