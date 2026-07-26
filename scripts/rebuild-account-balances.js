#!/usr/bin/env node
/**
 * Rebuild AccountBalance from posted journal entries for one company.
 * Usage: node scripts/rebuild-account-balances.js [companyId]
 */

const { rebuildAccountBalancesFromJournal } = require('../utils/accountBalanceSync');

const companyId = process.argv[2] || process.env.COMPANY_ID;

if (!companyId) {
  console.error('Usage: node scripts/rebuild-account-balances.js <companyId>');
  process.exit(1);
}

rebuildAccountBalancesFromJournal(companyId)
  .then((result) => {
    console.log('Rebuild complete:', result);
    process.exit(0);
  })
  .catch((err) => {
    console.error('Rebuild failed:', err);
    process.exit(1);
  });
