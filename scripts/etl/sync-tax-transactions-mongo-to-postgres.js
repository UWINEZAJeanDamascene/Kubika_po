/**
 * ETL: Sync TaxTransaction MongoDB → PostgreSQL.
 *
 * Usage:
 *   node scripts/etl/sync-tax-transactions-mongo-to-postgres.js
 *   node scripts/etl/sync-tax-transactions-mongo-to-postgres.js --dry-run
 *   node scripts/etl/sync-tax-transactions-mongo-to-postgres.js --company=507f1f77bcf86cd799439011
 *
 * Requires: MONGODB_URI and DATABASE_URL
 */
require('dotenv').config();

const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const { toPlainJson } = require('../../utils/objectId');
const { prisma, connectPrisma, disconnectPrisma } = require('../../lib/prisma');
const { taxTransactionTranslateCreate } = require('../../utils/taxMappers');

const DRY_RUN = process.argv.includes('--dry-run');
const SKIP_LOG = path.join(__dirname, 'etl_skipped.log');

function parseArg(prefix) {
  const arg = process.argv.find((a) => a.startsWith(`${prefix}=`));
  return arg ? arg.slice(prefix.length + 1) : null;
}

const COMPANY_FILTER = parseArg('--company');

function rawModel() {
  const modelName = 'EtlTaxTransaction';
  if (mongoose.models[modelName]) return mongoose.models[modelName];
  return mongoose.model(modelName, new mongoose.Schema({}, { strict: false, collection: 'taxtransactions' }));
}

function oid(v) {
  return v == null ? null : String(v);
}

function logSkip(id, reason) {
  const line = `${new Date().toISOString()}\ttax_transaction\t${id || 'unknown'}\t${reason}\n`;
  fs.appendFileSync(SKIP_LOG, line);
}

async function companyExists(id) {
  if (!id) return false;
  return Boolean(await prisma.company.findUnique({ where: { id }, select: { id: true } }));
}

async function main() {
  const mongoUri = process.env.MONGODB_URI;
  if (!mongoUri) {
    console.error('MONGODB_URI is not set — nothing to sync from Mongo.');
    process.exit(1);
  }

  await mongoose.connect(mongoUri);
  await connectPrisma();

  const TaxTransactionMongo = rawModel();
  const filter = COMPANY_FILTER ? { company: new mongoose.Types.ObjectId(COMPANY_FILTER) } : {};

  const total = await TaxTransactionMongo.countDocuments(filter);
  console.log(`TaxTransaction ETL: ${total} Mongo documents${DRY_RUN ? ' (dry-run)' : ''}`);

  let synced = 0;
  let skipped = 0;
  let errors = 0;
  const batchSize = 200;
  let lastId = null;

  while (true) {
    const query = { ...filter };
    if (lastId) query._id = { $gt: lastId };

    const docs = await TaxTransactionMongo.find(query).sort({ _id: 1 }).limit(batchSize).lean();
    if (!docs.length) break;

    for (const doc of docs) {
      const plain = toPlainJson(doc);
      const id = oid(plain._id);
      const companyId = oid(plain.company);

      try {
        if (!companyId || !(await companyExists(companyId))) {
          skipped++;
          logSkip(id, 'missing company');
          continue;
        }

        const payload = taxTransactionTranslateCreate(plain);

        if (DRY_RUN) {
          synced++;
          continue;
        }

        await prisma.taxTransaction.upsert({
          where: { id: payload.id },
          create: payload,
          update: payload,
        });
        synced++;
      } catch (err) {
        errors++;
        logSkip(id, err.message);
        console.error(`Skip ${id}:`, err.message);
      }
    }

    lastId = docs[docs.length - 1]._id;
    process.stdout.write(`\r  processed ${synced + skipped + errors}/${total}`);
  }

  console.log(`\nDone. synced=${synced} skipped=${skipped} errors=${errors}`);
  await mongoose.disconnect();
  await disconnectPrisma();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
