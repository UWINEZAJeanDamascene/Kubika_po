/**
 * Backfill tax_transactions from posted journal entries that have tax account
 * lines but no ledger rows yet.
 *
 * Use this after Mongo has been disabled to reconstruct the compliance window
 * where tax writes were silently skipped.
 *
 * Usage:
 *   node scripts/backfill-tax-transactions-from-journals.js
 *   node scripts/backfill-tax-transactions-from-journals.js --dry-run
 *   node scripts/backfill-tax-transactions-from-journals.js --company=COMPANY_ID
 *   node scripts/backfill-tax-transactions-from-journals.js --start=2026-01-01 --end=2026-08-31
 */
require('dotenv').config();

const { prisma, connectPrisma, disconnectPrisma } = require('../lib/prisma');
const TaxTransactionService = require('../services/taxTransactionService');

const DRY_RUN = process.argv.includes('--dry-run');

function parseArg(prefix) {
  const arg = process.argv.find((a) => a.startsWith(`${prefix}=`));
  return arg ? arg.slice(prefix.length + 1) : null;
}

const COMPANY_FILTER = parseArg('--company');
const START_DATE = parseArg('--start');
const END_DATE = parseArg('--end');

async function main() {
  await connectPrisma();

  const companies = COMPANY_FILTER
    ? [{ id: COMPANY_FILTER }]
    : await prisma.company.findMany({ where: { isActive: true }, select: { id: true, name: true } });

  console.log(
    `Tax transaction backfill${DRY_RUN ? ' (dry-run)' : ''}: ${companies.length} companies`,
  );

  let totalProcessed = 0;
  let totalSkipped = 0;
  let totalFailed = 0;

  for (const company of companies) {
    console.log(`\nCompany ${company.id}${company.name ? ` (${company.name})` : ''}`);

    if (DRY_RUN) {
      const missing = await countMissingForCompany(company.id);
      console.log(`  would backfill ~${missing} journal entries`);
      totalProcessed += missing;
      continue;
    }

    const result = await TaxTransactionService.backfillFromJournalEntries(company.id, {
      startDate: START_DATE,
      endDate: END_DATE,
      batchSize: 100,
    });

    console.log(`  processed=${result.processed} skipped=${result.skipped} failed=${result.failed}`);
    totalProcessed += result.processed;
    totalSkipped += result.skipped;
    totalFailed += result.failed;
  }

  console.log(
    `\nBackfill complete. processed=${totalProcessed} skipped=${totalSkipped} failed=${totalFailed}`,
  );
  await disconnectPrisma();
}

async function countMissingForCompany(companyId) {
  const taxCodes = Object.keys(TaxTransactionService.TAX_ACCOUNT_MAP);
  const entries = await prisma.journalEntry.findMany({
    where: {
      companyId,
      status: 'posted',
      ...(START_DATE || END_DATE
        ? {
            date: {
              ...(START_DATE ? { gte: new Date(START_DATE) } : {}),
              ...(END_DATE ? { lte: new Date(END_DATE) } : {}),
            },
          }
        : {}),
      lines: { some: { accountCode: { in: taxCodes } } },
    },
    select: { id: true },
  });

  if (!entries.length) return 0;

  const withTax = await prisma.taxTransaction.groupBy({
    by: ['journalEntryId'],
    where: {
      companyId,
      journalEntryId: { in: entries.map((e) => e.id) },
    },
    _count: { _all: true },
  });

  return entries.length - withTax.length;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
