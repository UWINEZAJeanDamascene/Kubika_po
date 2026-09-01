/**
 * Reconcile tax_transactions totals against journal-entry tax lines.
 *
 * Usage:
 *   node scripts/reconcile-tax-transactions.js
 *   node scripts/reconcile-tax-transactions.js --company=COMPANY_ID
 *   node scripts/reconcile-tax-transactions.js --start=2026-01-01 --end=2026-08-31
 */
require('dotenv').config();

const { prisma, connectPrisma, disconnectPrisma } = require('../lib/prisma');
const { decimalToNumber } = require('../utils/decimalHelpers');
const TaxTransactionService = require('../services/taxTransactionService');

function parseArg(prefix) {
  const arg = process.argv.find((a) => a.startsWith(`${prefix}=`));
  return arg ? arg.slice(prefix.length + 1) : null;
}

const COMPANY_FILTER = parseArg('--company');
const START_DATE = parseArg('--start');
const END_DATE = parseArg('--end');

const TAX_CODES = Object.keys(TaxTransactionService.TAX_ACCOUNT_MAP);

function lineTaxAmount(line) {
  const debit = Number(line.debit) || 0;
  const credit = Number(line.credit) || 0;
  return Math.max(debit, credit);
}

async function journalTaxTotal(companyId) {
  const dateFilter =
    START_DATE || END_DATE
      ? {
          ...(START_DATE ? { gte: new Date(START_DATE) } : {}),
          ...(END_DATE ? { lte: new Date(END_DATE) } : {}),
        }
      : undefined;

  const lines = await prisma.journalEntryLine.findMany({
    where: {
      companyId,
      accountCode: { in: TAX_CODES },
      journalEntry: {
        status: 'posted',
        ...(dateFilter ? { date: dateFilter } : {}),
      },
    },
    select: { debit: true, credit: true },
  });

  return lines.reduce((sum, line) => sum + lineTaxAmount(line), 0);
}

async function ledgerTaxTotal(companyId) {
  const where = {
    companyId,
    status: 'posted',
    accountCode: { in: TAX_CODES },
    ...(START_DATE || END_DATE
      ? {
          date: {
            ...(START_DATE ? { gte: new Date(START_DATE) } : {}),
            ...(END_DATE ? { lte: new Date(END_DATE) } : {}),
          },
        }
      : {}),
  };

  const agg = await prisma.taxTransaction.aggregate({
    where,
    _sum: { amount: true },
    _count: { _all: true },
  });

  return {
    total: decimalToNumber(agg._sum.amount),
    count: agg._count._all,
  };
}

async function main() {
  await connectPrisma();

  const companies = COMPANY_FILTER
    ? await prisma.company.findMany({ where: { id: COMPANY_FILTER }, select: { id: true, name: true } })
    : await prisma.company.findMany({ where: { isActive: true }, select: { id: true, name: true } });

  console.log('Tax transaction reconciliation');
  if (START_DATE || END_DATE) {
    console.log(`  period: ${START_DATE || '…'} → ${END_DATE || '…'}`);
  }

  let mismatches = 0;

  for (const company of companies) {
    const [journalTotal, ledger] = await Promise.all([
      journalTaxTotal(company.id),
      ledgerTaxTotal(company.id),
    ]);

    const delta = Math.round((ledger.total - journalTotal) * 100) / 100;
    const ok = Math.abs(delta) < 0.01;

    console.log(
      `\n${company.name || company.id}`,
      `\n  journal tax lines total : ${journalTotal.toFixed(2)}`,
      `\n  tax_transactions total  : ${ledger.total.toFixed(2)} (${ledger.count} rows)`,
      `\n  delta                     : ${delta.toFixed(2)} ${ok ? 'OK' : 'MISMATCH'}`,
    );

    if (!ok) mismatches++;
  }

  console.log(`\n${mismatches ? `${mismatches} mismatch(es)` : 'All companies reconciled'}.`);
  await disconnectPrisma();
  process.exit(mismatches ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
