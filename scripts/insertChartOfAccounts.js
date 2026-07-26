#!/usr/bin/env node
/*
  Script: insertChartOfAccounts.js
  Inserts or updates the canonical CHART_OF_ACCOUNTS into the database for a given company.

  Usage:
    node scripts/insertChartOfAccounts.js --companyId=<id>
    node scripts/insertChartOfAccounts.js --companyCode=<CODE>
    node scripts/insertChartOfAccounts.js            # will use first Company or create one
*/

const connectDB = require('../config/database');
const mongoose = require('mongoose');
const ChartOfAccount = require('../models/ChartOfAccount');
const Company = require('../models/Company'); // Prisma-backed shim
const { prisma, connectPrisma, disconnectPrisma } = require('../lib/prisma');
const { CHART_OF_ACCOUNTS } = require('../constants/chartOfAccounts');

function parseArgs() {
  const args = {};
  process.argv.slice(2).forEach((arg) => {
    const m = arg.match(/^--([^=]+)=?(.*)$/);
    if (m) args[m[1]] = m[2] || true;
  });
  return args;
}

async function findOrCreateCompany(args) {
  if (args.companyId) {
    const c = await Company.findById(args.companyId);
    if (!c) throw new Error(`Company with id ${args.companyId} not found`);
    return c;
  }

  if (args.companyCode) {
    const c = await Company.findOne({ code: args.companyCode.toUpperCase() });
    if (c) return c;
    // create
    return Company.create({ name: args.companyCode, code: args.companyCode.toUpperCase() });
  }

  // fallback: first existing company
  let c = await Company.findOne();
  if (c) return c;

  // create a default company if none exists
  c = await Company.create({ name: 'Default Company (chart import)', base_currency: 'RWF' });
  return c;
}

async function main() {
  const args = parseArgs();

  await connectDB();
  await connectPrisma(); // companies live in PostgreSQL

  try {
    const company = await findOrCreateCompany(args);
    console.log('Using company:', company._id.toString(), company.name);

    const bulkOps = [];

    for (const [codeKey, def] of Object.entries(CHART_OF_ACCOUNTS)) {
      const code = String(codeKey);
      const filter = { company: company._id, code };

      const update = {
        $set: {
          name: def.name,
          type: def.type || 'asset',
          subtype: def.subtype || null,
          normal_balance: def.normalBalance || def.normal_balance || 'debit',
          allow_direct_posting: typeof def.allowDirectPosting !== 'undefined' ? def.allowDirectPosting : true,
          isActive: true,
        },
        $setOnInsert: {
          createdAt: new Date(),
        },
      };

      bulkOps.push({ updateOne: { filter, update, upsert: true } });
    }

    if (bulkOps.length === 0) {
      console.log('No accounts to process.');
      process.exit(0);
    }

    console.log(`Performing bulk upsert of ${bulkOps.length} accounts...`);
    const result = await ChartOfAccount.bulkWrite(bulkOps, { ordered: false });

    console.log('Bulk write result:', JSON.stringify(result.toJSON ? result.toJSON() : result, null, 2));

    // Mark company setup step for chart of accounts (company lives in Postgres)
    try {
      const steps = { ...(company.setup_steps_completed || {}), chart_of_accounts: true };
      await prisma.company.update({
        where: { id: String(company._id) },
        data: { setupStepsCompleted: steps },
      });
    } catch (err) {
      console.warn('Could not update company setup steps:', err.message);
    }

    console.log('Done.');
    await mongoose.connection.close();
    await disconnectPrisma();
    process.exit(0);
  } catch (err) {
    console.error('Error during import:', err);
    await mongoose.connection.close();
    await disconnectPrisma().catch(() => {});
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}
