const { deepSerialize, toPublicUser } = require('../utils/apiSerializer');
const { generateObjectId } = require('../utils/objectId');
const { userToApi, companyToApi, roleToApi } = require('../utils/authMappers');
const { makeCompatModel } = require('../utils/prismaCompat');
const tenantContext = require('../lib/tenantContext');

describe('Phase 1 API serializer + objectId helpers', () => {
  test('generateObjectId returns 24-char hex', () => {
    const id = generateObjectId();
    expect(id).toMatch(/^[a-f0-9]{24}$/);
  });

  test('deepSerialize maps id to _id', () => {
    const result = deepSerialize({
      id: '507f1f77bcf86cd799439011',
      name: 'Acme',
      nested: { id: '507f1f77bcf86cd799439012', code: 'A' },
    });
    expect(result._id).toBe('507f1f77bcf86cd799439011');
    expect(result.id).toBeUndefined();
    expect(result.nested._id).toBe('507f1f77bcf86cd799439012');
  });

  test('toPublicUser strips secrets', () => {
    const result = toPublicUser({
      id: '507f1f77bcf86cd799439011',
      email: 'a@b.com',
      password: 'secret',
      refreshTokenHash: 'hash',
      twoFASecret: 'totp',
    });
    expect(result._id).toBe('507f1f77bcf86cd799439011');
    expect(result.password).toBeUndefined();
    expect(result.refreshTokenHash).toBeUndefined();
    expect(result.twoFASecret).toBeUndefined();
  });

  test('flattens UserRole join rows to Role docs', () => {
    const result = deepSerialize({
      id: 'u1',
      roles: [{ role: { id: 'r1', name: 'admin', permissions: [] } }],
    });
    expect(result.roles[0]._id).toBe('r1');
    expect(result.roles[0].name).toBe('admin');
  });
});

describe('Phase 1 API response parity (authMappers)', () => {
  test('companyToApi emits legacy snake_case fields and numeric billing_amount', () => {
    const row = {
      id: '507f1f77bcf86cd799439021',
      name: 'Acme Ltd',
      code: 'ACME',
      legalName: 'Acme Limited',
      logoUrl: '/uploads/logo.png',
      baseCurrency: 'RWF',
      fiscalYearStartMonth: 1,
      defaultPaymentTermsDays: 30,
      isActive: true,
      approvalStatus: 'approved',
      isVatRegistered: true,
      vatRatePct: 18,
      subscriptionPlan: 'starter',
      subscriptionStatus: 'active',
      billingCycle: 'monthly',
      // Prisma Decimal duck-type (Decimal(19,4) column)
      billingAmount: { toString: () => '15000.0000', toNumber: () => 15000 },
      setupStepsCompleted: { chart_of_accounts: true },
      featureAccess: {},
      subscriptionModules: ['inventory'],
      createdById: '507f1f77bcf86cd799439099',
      createdAt: new Date('2026-01-01T00:00:00Z'),
      updatedAt: new Date('2026-01-02T00:00:00Z'),
    };

    const api = companyToApi(row);
    expect(api._id).toBe(row.id);
    expect(api.legal_name).toBe('Acme Limited');
    expect(api.logo_url).toBe('/uploads/logo.png');
    expect(api.base_currency).toBe('RWF');
    expect(api.is_vat_registered).toBe(true);
    expect(api.billing_amount).toBe(15000);
    expect(typeof api.billing_amount).toBe('number');
    expect(api.setup_steps_completed).toEqual({ chart_of_accounts: true });
    expect(api.created_by).toBe(row.createdById);
    expect(api.approvalStatus).toBe('approved'); // legacy camelCase exception
    expect(api.isActive).toBe(true);
  });

  test('userToApi flattens roles include, maps legacy field names, never leaks password', () => {
    const row = {
      id: '507f1f77bcf86cd799439011',
      name: 'Jane',
      email: 'jane@acme.com',
      password: 'bcrypt-hash-should-never-appear',
      role: 'admin',
      companyId: '507f1f77bcf86cd799439021',
      company: { id: '507f1f77bcf86cd799439021', name: 'Acme Ltd', code: 'ACME', isActive: true, approvalStatus: 'approved' },
      roles: [{ role: { id: 'r1', name: 'Manager', isSystemRole: false, permissions: [] } }],
      isActive: true,
      failedLoginAttempts: 2,
      lockedUntil: null,
      mustChangePassword: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const api = userToApi(row);
    expect(api._id).toBe(row.id);
    expect(api.password).toBeUndefined();
    expect(api.company._id).toBe(row.companyId);
    expect(api.company.name).toBe('Acme Ltd');
    expect(api.roles[0]._id).toBe('r1');
    expect(api.roles[0].name).toBe('Manager');
    expect(api.failed_login_attempts).toBe(2);
    expect(api.locked_until).toBeNull();
  });

  test('userToApi keeps company as plain id when relation is not included', () => {
    const api = userToApi({
      id: 'u1',
      name: 'Jane',
      email: 'jane@acme.com',
      role: 'viewer',
      companyId: 'c1',
      isActive: true,
    });
    expect(api.company).toBe('c1');
    expect(api.roles).toEqual([]);
  });

  test('roleToApi emits legacy is_system_role / company_id', () => {
    const api = roleToApi({
      id: 'r1',
      companyId: 'c1',
      name: 'Manager',
      description: null,
      isSystemRole: false,
      permissions: [{ resource: 'products', actions: ['read'] }],
    });
    expect(api._id).toBe('r1');
    expect(api.company_id).toBe('c1');
    expect(api.is_system_role).toBe(false);
    expect(api.permissions).toHaveLength(1);
  });
});

describe('Phase 1 tenant isolation (prismaCompat)', () => {
  let captured;
  let Model;

  beforeEach(() => {
    captured = {};
    const fakeDelegate = {
      findMany: async (args) => { captured.findMany = args; return []; },
      findFirst: async (args) => { captured.findFirst = args; return null; },
      findUnique: async (args) => { captured.findUnique = args; return { id: 'u1', companyId: 'c2' }; },
      count: async (args) => { captured.count = args; return 0; },
      create: async (args) => { captured.create = args; return { ...args.data }; },
      updateMany: async (args) => { captured.updateMany = args; return { count: 0 }; },
      deleteMany: async (args) => { captured.deleteMany = args; return { count: 0 }; },
    };
    Model = makeCompatModel({
      delegate: () => fakeDelegate,
      fieldMap: {
        _id: { target: 'id', isId: true },
        company: { target: 'companyId', isId: true },
        role: { target: 'role' },
      },
      toApi: (r) => r,
      translateCreate: async (d) => d,
      translateUpdate: (u) => u,
      tenantField: 'companyId',
    });
  });

  test('injects companyId from tenant context into find()', async () => {
    await tenantContext.run({ companyId: 'c1' }, () => Model.find({ role: 'admin' }));
    expect(captured.findMany.where).toEqual({ role: 'admin', companyId: 'c1' });
  });

  test('explicit company filter suppresses injection', async () => {
    await tenantContext.run({ companyId: 'c1' }, () => Model.find({ company: 'c9', role: 'admin' }));
    expect(captured.findMany.where).toEqual({ companyId: 'c9', role: 'admin' });
  });

  test('skipTenant opts out (setOptions parity with Mongoose)', async () => {
    await tenantContext.run({ companyId: 'c1' }, () =>
      Model.find({ role: 'admin' }).setOptions({ skipTenant: true }),
    );
    expect(captured.findMany.where).toEqual({ role: 'admin' });
  });

  test('no tenant context means no injection (scripts, ETL)', async () => {
    await Model.countDocuments({ role: 'admin' });
    expect(captured.count.where).toEqual({ role: 'admin' });
  });

  test('updateMany and deleteMany are tenant-scoped', async () => {
    await tenantContext.run({ companyId: 'c1' }, async () => {
      await Model.updateMany({ role: 'viewer' }, { role: 'sales' });
      await Model.deleteMany({ role: 'viewer' });
    });
    expect(captured.updateMany.where).toEqual({ role: 'viewer', companyId: 'c1' });
    expect(captured.deleteMany.where).toEqual({ role: 'viewer', companyId: 'c1' });
  });

  test('findById hides documents from another tenant (legacy findOne hook parity)', async () => {
    // fake delegate returns a row with companyId 'c2'
    const hit = await tenantContext.run({ companyId: 'c1' }, () => Model.findById('u1'));
    expect(hit).toBeNull();
    const visible = await tenantContext.run({ companyId: 'c2' }, () => Model.findById('u1'));
    expect(visible.toObject()).toEqual({ id: 'u1', companyId: 'c2' });
  });

  test('columns the Prisma model does not declare are dropped from writes', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    // Shared mappers emit createdById for every tenant model; stock_movements has no such column.
    const stockMovements = makeCompatModel({
      delegate: () => ({
        name: 'StockMovement',
        create: async (args) => { captured.create = args; return { id: 'm1' }; },
        updateMany: async (args) => { captured.updateMany = args; return { count: 1 }; },
      }),
      fieldMap: { _id: { target: 'id', isId: true } },
      toApi: (r) => r,
      translateCreate: async (d) => ({ ...d, createdById: null }),
      translateUpdate: (u) => ({ ...u, createdById: null }),
    });

    await stockMovements.create({ id: 'm1', reason: 'correction' });
    expect(captured.create.data).toEqual({ id: 'm1', reason: 'correction' });

    await stockMovements.updateMany({}, { notes: 'edited' });
    expect(captured.updateMany.data).toEqual({ notes: 'edited' });

    warn.mockRestore();
  });

  test('create([doc]) returns an array, as Mongoose does', async () => {
    const created = await tenantContext.run({ companyId: 'c1' }, () =>
      Model.create([{ _id: 'u7', role: 'sales' }]));
    expect(Array.isArray(created)).toBe(true);
    expect(created).toHaveLength(1);
    expect(captured.create.data).toEqual({ _id: 'u7', role: 'sales' });
  });

  test('new Model(doc) inserts on first save and updates afterwards', async () => {
    const updates = [];
    const layers = makeCompatModel({
      delegate: () => ({
        name: 'FakeInventoryLayer',
        create: async (args) => { captured.create = args; return { ...args.data, createdAt: 'now' }; },
        findFirst: async () => ({ id: 'l1' }),
        update: async (args) => { updates.push(args); return { ...args.data, id: 'l1' }; },
      }),
      fieldMap: { _id: { target: 'id', isId: true }, qtyRemaining: { target: 'qtyRemaining' } },
      toApi: (r) => r,
      translateCreate: async (d) => d,
      translateUpdate: (u) => ({ ...(u.$set || u) }),
      mutable: true,
    });

    const doc = new layers({ _id: 'l1', qtyRemaining: 5 });
    expect(typeof doc.save).toBe('function');

    await doc.save();
    expect(captured.create.data).toEqual({ _id: 'l1', qtyRemaining: 5 });

    doc.qtyRemaining = 3;
    await doc.save();
    expect(updates).toHaveLength(1);
    expect(updates[0].data.qtyRemaining).toBe(3);
    expect(doc.qtyRemaining).toBe(3);
  });

  test('populate paths that are not Prisma relations are dropped from include', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    // Invoice.quotationId is a plain column, so `include: { quotation: ... }` is invalid.
    const invoices = makeCompatModel({
      delegate: () => ({
        name: 'Invoice',
        findMany: async (args) => { captured.findMany = args; return []; },
      }),
      fieldMap: { _id: { target: 'id', isId: true } },
      toApi: (r) => r,
      translateCreate: async (d) => d,
      translateUpdate: (u) => u,
      include: () => ({ lines: true, client: true, quotation: { select: { id: true } } }),
    });

    await invoices.find({}).populate('client').populate('quotation', 'referenceNo');
    expect(captured.findMany.include).toEqual({ lines: true, client: true });

    warn.mockRestore();
  });

  test('date-only strings are cast for DateTime columns', async () => {
    const salesOrders = makeCompatModel({
      delegate: () => ({
        name: 'SalesOrder',
        create: async (args) => { captured.create = args; return { id: 'so1' }; },
        updateMany: async (args) => { captured.updateMany = args; return { count: 1 }; },
      }),
      fieldMap: { _id: { target: 'id', isId: true } },
      toApi: (r) => r,
      translateCreate: async (d) => d,
      translateUpdate: (u) => ({ ...(u.$set || u) }),
    });

    await salesOrders.create({ id: 'so1', orderDate: '2026-07-25', expectedDate: '' });
    expect(captured.create.data.orderDate).toEqual(new Date('2026-07-25T00:00:00.000Z'));
    expect(captured.create.data.expectedDate).toBeNull();

    await salesOrders.updateMany({}, { orderDate: '2026-07-26' });
    expect(captured.updateMany.data.orderDate).toEqual(new Date('2026-07-26T00:00:00.000Z'));
  });

  test('date-only strings inside nested line writes are cast too', async () => {
    const transfers = makeCompatModel({
      delegate: () => ({
        name: 'StockTransfer',
        create: async (args) => { captured.create = args; return { id: 't1' }; },
      }),
      fieldMap: { _id: { target: 'id', isId: true } },
      toApi: (r) => r,
      translateCreate: async (d) => d,
      translateUpdate: (u) => u,
    });

    await transfers.create({
      id: 't1',
      transferDate: '2026-07-25',
      lines: { create: [{ id: 'l1', createdAt: '2026-08-01' }] },
    });
    expect(captured.create.data.transferDate).toEqual(new Date('2026-07-25T00:00:00.000Z'));
    expect(captured.create.data.lines.create[0].createdAt).toEqual(new Date('2026-08-01T00:00:00.000Z'));
  });

  test('save() rewrites line rows only when the lines array was replaced', async () => {
    const updates = [];
    const salesOrders = makeCompatModel({
      delegate: () => ({
        name: 'SalesOrder',
        findFirst: async () => ({ id: 'so1', referenceNo: 'SO-1', status: 'draft', lines: [{ id: 'l1', qty: 5 }] }),
        update: async (args) => { updates.push(args); return { id: 'so1', lines: [] }; },
      }),
      fieldMap: { _id: { target: 'id', isId: true } },
      toApi: (r) => r,
      translateCreate: async (d) => ({
        ...d,
        lines: { create: (d.lines || []).map((l) => ({ id: l.id, qty: l.qty })) },
      }),
      translateUpdate: (u) => ({ status: (u.$set || u).status }),
      include: () => ({ lines: true }),
      mutable: true,
    });

    const doc = await salesOrders.findOne({ _id: 'so1' });
    doc.status = 'confirmed';
    await doc.save();
    expect(updates[0].data.lines).toBeUndefined();

    const reloaded = await salesOrders.findOne({ _id: 'so1' });
    reloaded.lines = [{ id: 'l2', qty: 2 }];
    await reloaded.save();
    expect(updates[1].data.lines).toEqual({ deleteMany: {}, create: [{ id: 'l2', qty: 2 }] });
  });

  test('new Model() without an _id still gets one, as Mongoose does', () => {
    const doc = new Model({ role: 'sales' });
    expect(doc._id).toMatch(/^[0-9a-f]{24}$/);
  });

  test('$inc becomes a Prisma atomic increment', async () => {
    const products = makeCompatModel({
      delegate: () => ({
        name: 'Product',
        findFirst: async () => ({ id: 'p1' }),
        update: async (args) => { captured.update = args; return { id: 'p1' }; },
        updateMany: async (args) => { captured.updateMany = args; return { count: 1 }; },
      }),
      fieldMap: { _id: { target: 'id', isId: true } },
      toApi: (r) => r,
      translateCreate: async (d) => d,
      translateUpdate: (u) => ({ ...(u.$set || {}) }),
    });

    await products.findByIdAndUpdate('p1', { $inc: { currentStock: -2 }, lastSaleDate: null });
    expect(captured.update.data.currentStock).toEqual({ increment: -2 });

    await products.updateMany({}, { $inc: { reorderPoint: 5 } });
    expect(captured.updateMany.data.reorderPoint).toEqual({ increment: 5 });
  });

  test('models without tenantField are never auto-scoped (Company/Role parity)', async () => {
    const untenanted = makeCompatModel({
      delegate: () => ({ findMany: async (args) => { captured.findMany = args; return []; } }),
      fieldMap: { _id: { target: 'id', isId: true }, name: { target: 'name' } },
      toApi: (r) => r,
      translateCreate: async (d) => d,
      translateUpdate: (u) => u,
    });
    await tenantContext.run({ companyId: 'c1' }, () => untenanted.find({ name: 'Acme' }));
    expect(captured.findMany.where).toEqual({ name: 'Acme' });
  });
});
