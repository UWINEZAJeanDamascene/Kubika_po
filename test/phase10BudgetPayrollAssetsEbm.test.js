const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const {
  assetCategoryToApi,
  fixedAssetToApi,
  employeeToApi,
  budgetToApi,
  payrollRunToApi,
  ebmDeviceToApi,
  ebmTinToApi,
  projectToApi,
} = require('../utils/phase10Mappers');

describe('Phase 10 budget/payroll/assets/EBM mappers', () => {
  test('assetCategoryToApi maps depreciation defaults', () => {
    const api = assetCategoryToApi({
      id: 'ac1',
      companyId: 'c1',
      name: 'Vehicles',
      description: 'Motor vehicles',
      defaultUsefulLifeMonths: 60,
      defaultDepreciationMethod: 'straight_line',
      defaultDecliningRate: null,
      defaultAssetAccountCode: '1700',
      defaultAccumDepreciationAccountCode: '1810',
      defaultDepreciationExpenseAccountCode: '5800',
      isComponentizable: false,
      isDepreciable: true,
      defaultDepreciationFrequency: 'monthly',
      isSystem: false,
      isDeleted: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    expect(api._id).toBe('ac1');
    expect(api.company).toBe('c1');
    expect(api.name).toBe('Vehicles');
    expect(api.defaultUsefulLifeMonths).toBe(60);
    expect(api.isDepreciable).toBe(true);
  });

  test('fixedAssetToApi maps purchase and NBV fields', () => {
    const api = fixedAssetToApi({
      id: 'fa1',
      companyId: 'c1',
      name: 'Delivery Van',
      assetAccountCode: '1700',
      accumDepreciationAccountCode: '1810',
      depreciationExpenseAccountCode: '5800',
      purchaseDate: new Date('2024-01-15'),
      purchaseCost: 25000000,
      salvageValue: 0,
      usefulLifeMonths: 60,
      depreciationMethod: 'straight_line',
      status: 'in_service',
      isReadyForService: true,
      accumulatedDepreciation: 5000000,
      netBookValue: 20000000,
      depreciationFrequency: 'monthly',
      acquisitionMethod: 'purchase',
      isDeleted: false,
      createdById: 'u1',
      attachments: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    expect(api._id).toBe('fa1');
    expect(api.purchaseCost).toBe(25000000);
    expect(api.netBookValue).toBe(20000000);
    expect(api.createdBy).toBe('u1');
  });

  test('employeeToApi maps HR identity fields', () => {
    const api = employeeToApi({
      id: 'e1',
      companyId: 'c1',
      employeeId: 'EMP-001',
      status: 'active',
      firstName: 'Jean',
      lastName: 'Uwimana',
      employmentType: 'full-time',
      taxStatus: 'resident',
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    expect(api._id).toBe('e1');
    expect(api.employeeId).toBe('EMP-001');
    expect(api.firstName).toBe('Jean');
    expect(api.status).toBe('active');
  });

  test('payrollRunToApi maps snake_case totals', () => {
    const api = payrollRunToApi({
      id: 'pr1',
      companyId: 'c1',
      referenceNo: 'PAY-2026-06',
      payPeriodStart: new Date('2026-06-01'),
      payPeriodEnd: new Date('2026-06-30'),
      paymentDate: new Date('2026-07-05'),
      status: 'posted',
      totalGross: 15000000,
      totalTax: 2000000,
      totalOtherDeductions: 500000,
      totalNet: 12500000,
      bankAccountId: 'ba1',
      salaryAccountId: '6100',
      taxPayableAccountId: '2200',
      lines: [],
      employeeCount: 12,
      remittance: {},
      bankTransfer: {},
      warnings: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    expect(api.reference_no).toBe('PAY-2026-06');
    expect(api.total_gross).toBe(15000000);
    expect(api.total_net).toBe(12500000);
    expect(api.employee_count).toBe(12);
  });

  test('budgetToApi maps snake_case company_id', () => {
    const api = budgetToApi({
      id: 'b1',
      companyId: 'c1',
      name: 'FY2026 Operations',
      description: '',
      purpose: '',
      type: 'expense',
      budgetCycle: 'fixed_year',
      fiscalYear: 2026,
      periodType: 'yearly',
      amount: 50000000,
      exchangeRateType: 'spot',
      exchangeRate: 1,
      allowMultiCurrency: false,
      allocationMethod: 'manual',
      status: 'draft',
      currentApprovalStep: 0,
      totalApprovalSteps: 0,
      createdById: 'u1',
      rejectionReason: '',
      closeNotes: '',
      notes: '',
      autoLock: {},
      yearEndLock: false,
      autoLocked: false,
      scenarioType: 'base',
      isPrimaryScenario: true,
      scenarioDescription: '',
      tags: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    expect(api._id).toBe('b1');
    expect(api.company_id).toBe('c1');
    expect(api.fiscal_year).toBe(2026);
    expect(api.amount).toBe(50000000);
  });

  test('projectToApi maps WBS and budget fields', () => {
    const api = projectToApi({
      id: 'p1',
      companyId: 'c1',
      projectCode: 'PRJ-001',
      name: 'HQ Renovation',
      description: '',
      wbsLevel: 1,
      wbsCode: '1',
      type: 'project',
      status: 'active',
      priority: 'high',
      budgetAllocated: 10000000,
      budgetSpent: 2500000,
      budgetRemaining: 7500000,
      billingType: 'none',
      contractValue: 0,
      progressPercent: 25,
      isActive: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    expect(api.project_code).toBe('PRJ-001');
    expect(api.budget_allocated).toBe(10000000);
    expect(api.progress_percent).toBe(25);
  });

  test('ebmDeviceToApi maps device registration', () => {
    const api = ebmDeviceToApi({
      id: 'ed1',
      companyId: 'c1',
      tin: '123456789',
      branchId: '00',
      deviceSerialNo: 'SN-001',
      status: 'initialized',
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    expect(api._id).toBe('ed1');
    expect(api.tin).toBe('123456789');
    expect(api.deviceSerialNo).toBe('SN-001');
    expect(api.status).toBe('initialized');
  });

  test('ebmTinToApi maps global taxpayer registry (no company)', () => {
    const api = ebmTinToApi({
      id: 'et1',
      tin: '987654321',
      taxpayerName: 'Acme Ltd',
      active: true,
      source: {},
      lastSyncedAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    expect(api._id).toBe('et1');
    expect(api.tin).toBe('987654321');
    expect(api.taxpayerName).toBe('Acme Ltd');
    expect(api.company).toBeUndefined();
    expect(api.companyId).toBeUndefined();
  });
});

describe('Phase 10 Neon integration', () => {
  const hasDb = Boolean(process.env.DATABASE_URL);

  (hasDb ? test : test.skip)('asset_categories table exists on Neon', async () => {
    const { prisma, connectPrisma, disconnectPrisma } = require('../lib/prisma');
    await connectPrisma();
    const tables = await prisma.$queryRawUnsafe(
      `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename = 'asset_categories'`,
    );
    expect(tables.length).toBe(1);
    await disconnectPrisma();
  });

  (hasDb ? test : test.skip)('employees table exists on Neon', async () => {
    const { prisma, connectPrisma, disconnectPrisma } = require('../lib/prisma');
    await connectPrisma();
    const tables = await prisma.$queryRawUnsafe(
      `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename = 'employees'`,
    );
    expect(tables.length).toBe(1);
    await disconnectPrisma();
  });

  (hasDb ? test : test.skip)('budgets table exists on Neon', async () => {
    const { prisma, connectPrisma, disconnectPrisma } = require('../lib/prisma');
    await connectPrisma();
    const tables = await prisma.$queryRawUnsafe(
      `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename = 'budgets'`,
    );
    expect(tables.length).toBe(1);
    await disconnectPrisma();
  });

  (hasDb ? test : test.skip)('ebm_devices table exists on Neon', async () => {
    const { prisma, connectPrisma, disconnectPrisma } = require('../lib/prisma');
    await connectPrisma();
    const tables = await prisma.$queryRawUnsafe(
      `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename = 'ebm_devices'`,
    );
    expect(tables.length).toBe(1);
    await disconnectPrisma();
  });
});
