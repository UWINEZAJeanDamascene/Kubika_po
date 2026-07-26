/**
 * ETL: copy Mongo Sequence + EBMSequence counters into PostgreSQL.
 * Idempotent — uses GREATEST when a Postgres row already exists.
 *
 * Usage:
 *   npm run etl:sequences        # live sync (needs MONGODB_URI + DATABASE_URL)
 *   npm run etl:sequences:dry      # dry run
 */
require('dotenv').config();
const mongoose = require('mongoose');
const { prisma, connectPrisma, disconnectPrisma } = require('../../lib/prisma');

const DRY_RUN = process.argv.includes('--dry-run');

function rawModel(name, collection) {
  const modelName = `Etl${name}`;
  if (mongoose.models[modelName]) return mongoose.models[modelName];
  return mongoose.model(modelName, new mongoose.Schema({}, { strict: false, collection }));
}

function oid(value) {
  if (!value) return null;
  return String(value);
}

async function syncSequences() {
  const Sequence = rawModel('Sequence', 'sequences');
  const docs = await Sequence.find({}).lean();
  let upserted = 0;

  for (const doc of docs) {
    const companyId = oid(doc.company);
    if (!companyId) continue;
    const name = String(doc.name || '');
    const year = Number(doc.year) || 0;
    const value = Number(doc.seq) || 0;

    if (DRY_RUN) {
      console.log('[dry] sequence', { companyId, name, year, value });
      upserted += 1;
      continue;
    }

    await prisma.$executeRawUnsafe(
      `INSERT INTO sequences (company_id, name, year, value, created_at, updated_at)
       VALUES ($1, $2, $3, $4, NOW(), NOW())
       ON CONFLICT (company_id, name, year)
       DO UPDATE SET value = GREATEST(sequences.value, EXCLUDED.value), updated_at = NOW()`,
      companyId,
      name,
      year,
      value,
    );
    upserted += 1;
  }
  return upserted;
}

const EBM_TYPE_MAP = {
  sales_invoice: 'sales_invoice',
  receipt: 'receipt',
  report: 'report',
  stock_sar: 'stock_sar',
};

async function syncEbmSequences() {
  const EBMSequence = rawModel('EBMSequence', 'ebmsequences');
  const docs = await EBMSequence.find({}).lean();
  let upserted = 0;

  for (const doc of docs) {
    const companyId = oid(doc.company);
    if (!companyId) continue;
    const branchId = String(doc.branchId || '00').padStart(2, '0').slice(-2);
    const sequenceType = EBM_TYPE_MAP[doc.sequenceType] || doc.sequenceType;
    if (!sequenceType || !EBM_TYPE_MAP[sequenceType]) continue;
    const lastNumber = Number(doc.lastNumber) || 0;

    if (DRY_RUN) {
      console.log('[dry] ebm_sequence', { companyId, branchId, sequenceType, lastNumber });
      upserted += 1;
      continue;
    }

    await prisma.$executeRawUnsafe(
      `INSERT INTO ebm_sequences
         (company_id, branch_id, sequence_type, last_number, seeded_from, seeded_at, created_at, updated_at)
       VALUES ($1, $2, $3::"EbmSequenceType", $4, $5, $6, NOW(), NOW())
       ON CONFLICT (company_id, branch_id, sequence_type)
       DO UPDATE SET
         last_number = GREATEST(ebm_sequences.last_number, EXCLUDED.last_number),
         seeded_from = COALESCE(ebm_sequences.seeded_from, EXCLUDED.seeded_from),
         seeded_at = COALESCE(ebm_sequences.seeded_at, EXCLUDED.seeded_at),
         updated_at = NOW()`,
      companyId,
      branchId,
      sequenceType,
      lastNumber,
      doc.seededFrom || null,
      doc.seededAt || null,
    );
    upserted += 1;
  }
  return upserted;
}

async function main() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL required');
  if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI required for source read');

  console.log(DRY_RUN ? '=== DRY RUN ===' : '=== SYNC Sequences Mongo → Postgres ===');
  await mongoose.connect(process.env.MONGODB_URI);
  await connectPrisma();

  const results = {
    sequences: await syncSequences(),
    ebmSequences: await syncEbmSequences(),
  };

  console.log('Done:', results);
  await disconnectPrisma();
  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await disconnectPrisma().catch(() => {});
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
