const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const {
  bankAccountToApi,
  pettyCashFloatToApi,
  reportSnapshotToApi,
} = require('../utils/bankingMappers');

describe('Phase 7+9 banking/report mappers', () => {
  test('bankAccountToApi maps balances and interest fields', () => {
    const api = bankAccountToApi({
      id: 'ba1',
      companyId: 'c1',
      name: 'Main Operating Account',
      accountNumber: '1234567890',
      bankName: 'BK Bank',
      currencyCode: 'RWF',
      ledgerAccountId: '1100',
      openingBalance: 50000,
      openingBalanceDate: new Date('2026-01-01'),
      isActive: true,
      isDefault: true,
      accountType: 'bk_bank',
      cachedBalance: 75000,
      cacheValid: true,
      targetBalance: 100000,
      lastReconciledBalance: 74000,
      interestRate: 2.5,
      interestAccountType: 'current',
      interestCalculationMethod: 'simple',
      interestCreditFrequency: 'monthly',
      interestIncomeAccount: '4300',
      interestAccrualAccount: '1350',
      bankStatementReference: false,
      color: '#3B82F6',
      icon: 'bank',
      customFields: {},
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    expect(api._id).toBe('ba1');
    expect(api.company).toBe('c1');
    expect(api.openingBalance).toBe(50000);
    expect(api.cachedBalance).toBe(75000);
    expect(api.interestRate).toBe(2.5);
    expect(api.isDefault).toBe(true);
  });

  test('pettyCashFloatToApi maps float and custodian', () => {
    const api = pettyCashFloatToApi({
      id: 'pf1',
      companyId: 'c1',
      name: 'Office Petty Cash',
      ledgerAccountId: '1050',
      openingBalance: 100000,
      currentBalance: 85000,
      floatAmount: 100000,
      imprestMode: true,
      minimumBalance: 10000,
      custodianId: 'u1',
      location: 'HQ Reception',
      isActive: true,
      cachedBalance: 85000,
      cacheValid: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    expect(api._id).toBe('pf1');
    expect(api.custodian).toBe('u1');
    expect(api.floatAmount).toBe(100000);
    expect(api.currentBalance).toBe(85000);
    expect(api.imprestMode).toBe(true);
  });

  test('reportSnapshotToApi maps period and summary data', () => {
    const api = reportSnapshotToApi({
      id: 'rs1',
      companyId: 'c1',
      reportType: 'sales_summary',
      periodType: 'monthly',
      periodStart: new Date('2026-06-01'),
      periodEnd: new Date('2026-06-30'),
      periodLabel: 'June 2026',
      year: 2026,
      periodNumber: 6,
      data: { totalSales: 1500000 },
      summary: { revenue: 1500000, orders: 42 },
      topProducts: [{ name: 'Widget', qty: 100 }],
      topCustomers: [{ name: 'Acme Corp', total: 500000 }],
      comparison: { priorPeriod: 1200000 },
      generatedAt: new Date(),
      calculationSource: 'snapshot',
      status: 'completed',
      version: 1,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    expect(api._id).toBe('rs1');
    expect(api.reportType).toBe('sales_summary');
    expect(api.periodLabel).toBe('June 2026');
    expect(api.summary.revenue).toBe(1500000);
    expect(api.topProducts).toHaveLength(1);
    expect(api.status).toBe('completed');
  });
});

describe('Phase 7+9 Neon integration', () => {
  const hasDb = Boolean(process.env.DATABASE_URL);

  (hasDb ? test : test.skip)('bank_accounts table exists on Neon', async () => {
    const { prisma, connectPrisma, disconnectPrisma } = require('../lib/prisma');
    await connectPrisma();
    const tables = await prisma.$queryRawUnsafe(
      `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename IN ('bank_accounts', 'bank_transactions')`,
    );
    expect(tables.length).toBeGreaterThanOrEqual(2);
    await disconnectPrisma();
  });

  (hasDb ? test : test.skip)('petty_cash_floats table exists on Neon', async () => {
    const { prisma, connectPrisma, disconnectPrisma } = require('../lib/prisma');
    await connectPrisma();
    const tables = await prisma.$queryRawUnsafe(
      `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename IN ('petty_cash_floats', 'petty_cash_expenses')`,
    );
    expect(tables.length).toBeGreaterThanOrEqual(2);
    await disconnectPrisma();
  });

  (hasDb ? test : test.skip)('report_snapshots table exists on Neon', async () => {
    const { prisma, connectPrisma, disconnectPrisma } = require('../lib/prisma');
    await connectPrisma();
    const tables = await prisma.$queryRawUnsafe(
      `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename = 'report_snapshots'`,
    );
    expect(tables.length).toBe(1);
    await disconnectPrisma();
  });
});
