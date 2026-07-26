/**
 * Document reference numbers (INV-2026-00001, SO-2026-00004, ...).
 *
 * The Mongoose models assigned these in a `pre('save')` hook. Prisma has no
 * hooks, so the create mappers wrap themselves in `withReferenceNo` to keep the
 * numbering — and the format — identical to the pre-migration data.
 */

const { toIdString } = require('./objectId');
const { referenceYear, padSequence } = require('../models/utils/autoIncrement');
const { incrementSequence, ensureMinSequence } = require('../services/postgresSequenceStore');

/** Field names callers historically used for the document number. */
const REFERENCE_ALIASES = [
  'referenceNo',
  'quotationNumber',
  'invoiceNumber',
  'creditNoteNumber',
  'deliveryNumber',
  'receiptNumber',
  'orderNumber',
  'paymentNumber',
  'returnNumber',
  'grnNumber',
  'auditNumber',
  'transferNumber',
  'purchaseNumber',
];

/** Counters already lifted above the migrated numbering, per process. */
const seededSequences = new Set();

function sequenceName(prefix, field) {
  return `${String(prefix).toLowerCase()}_${String(field).toLowerCase()}`;
}

/**
 * Rows migrated from Mongo already carry numbers such as INV-2026-00068 while
 * the Postgres counter for that company starts at zero. Lift the counter above
 * the highest existing number so the first generated number does not collide
 * with a migrated one.
 */
async function seedFromExistingRows(companyId, prefix, { year, name, field, model }) {
  const key = `${companyId}|${name}|${year}`;
  if (!model || seededSequences.has(key)) return;
  seededSequences.add(key);

  try {
    const { prisma } = require('../lib/prisma');
    const delegate = prisma[model];
    if (!delegate) return;

    const pattern = year ? `${prefix}-${year}-` : `${prefix}-`;
    const rows = await delegate.findMany({
      where: { companyId, [field]: { startsWith: pattern } },
      select: { [field]: true },
      orderBy: { [field]: 'desc' },
      take: 1,
    });

    const highest = parseInt(String(rows[0]?.[field] ?? '').slice(pattern.length), 10);
    if (Number.isFinite(highest) && highest > 0) {
      await ensureMinSequence(companyId, name, year, highest);
    }
  } catch (err) {
    seededSequences.delete(key);
    console.warn(`referenceNumbers: could not seed ${name} for company ${companyId}: ${err.message}`);
  }
}

/**
 * Allocate the next document number for a company.
 *
 * @param {string} companyId
 * @param {string} prefix e.g. 'INV'
 * @param {{ yearScoped?: boolean, field?: string, model?: string }} [options]
 *   `model` is the Prisma delegate name, used to seed the counter past migrated rows.
 */
async function nextReferenceNo(companyId, prefix, options = {}) {
  const { yearScoped = true, field = 'referenceNo', model = null } = options;
  const year = yearScoped ? referenceYear() : 0;
  const name = sequenceName(prefix, field);

  await seedFromExistingRows(companyId, prefix, { year, name, field, model });

  const value = padSequence(await incrementSequence(companyId, name, year));
  return year ? `${prefix}-${year}-${value}` : `${prefix}-${value}`;
}

/**
 * Wrap a create mapper so the produced payload always carries a document number.
 *
 * @param {string} prefix document prefix, e.g. 'INV'
 * @param {(data: object) => object|Promise<object>} translate the mapper to wrap
 * @param {{ yearScoped?: boolean, field?: string, model?: string }} [options]
 *   `yearScoped: false` yields PREFIX-NNNNN (RecurringInvoice);
 *   `field` targets a differently named column (StockTransfer.transferNumber).
 */
function withReferenceNo(prefix, translate, options = {}) {
  const { field = 'referenceNo' } = options;
  return async (data = {}) => {
    const payload = await translate(data);
    if (!payload || typeof payload !== 'object' || payload[field]) return payload;

    const supplied = [field, ...REFERENCE_ALIASES].map((key) => data[key]).find(Boolean);
    if (supplied) return { ...payload, [field]: String(supplied) };

    const companyId = payload.companyId || toIdString(data.company || data.companyId);
    if (!companyId) return payload;

    return { ...payload, [field]: await nextReferenceNo(companyId, prefix, options) };
  };
}

module.exports = { withReferenceNo, nextReferenceNo };
