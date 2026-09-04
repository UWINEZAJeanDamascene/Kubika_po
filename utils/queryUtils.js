const { decodeCursor } = require('./cursorPagination');
const { dbClient } = require('../lib/prisma');
const { MAX_BATCH_SIZE, getReadContext } = require('../lib/readContext');
const { parseBoundedLimit, assertReadLimit } = require('./querySafety');

const DEFAULT_PAGE = 1;
const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

const SELECT_SHAPES = Object.freeze({
  deliveryNoteList: {
    id: true, companyId: true, referenceNo: true, salesOrderId: true,
    pickPackId: true, invoiceId: true, clientId: true, warehouseId: true,
    quotationId: true, deliveryDate: true, status: true, stockDeducted: true,
    notes: true, createdById: true, createdAt: true, updatedAt: true,
    client: { select: { id: true, name: true, code: true, tin: true } },
    warehouse: { select: { id: true, name: true, code: true } },
    lines: {
      select: {
        id: true, lineOrder: true, productId: true, productName: true,
        productCode: true, description: true, qtyToDeliver: true,
        deliveredQty: true, unit: true, unitPrice: true, lineTotal: true,
        product: { select: { id: true, name: true, sku: true, unit: true } },
      },
    },
  },
  pickPackList: {
    id: true, companyId: true, referenceNo: true, salesOrderId: true,
    clientId: true, warehouseId: true, assignedToId: true, status: true,
    priority: true, notes: true, createdAt: true, updatedAt: true,
    client: { select: { id: true, name: true, code: true } },
    warehouse: { select: { id: true, name: true, code: true } },
    lines: { select: { id: true, lineOrder: true, productId: true, qtyToPick: true, qtyPicked: true, qtyPacked: true, status: true } },
  },
  salesOrderList: {
    id: true, companyId: true, referenceNo: true, clientId: true,
    quotationId: true, orderDate: true, expectedDate: true, status: true,
    currencyCode: true, totalAmount: true, fulfillmentStatus: true,
    notes: true, createdAt: true, updatedAt: true,
    client: { select: { id: true, name: true, code: true, tin: true } },
    lines: { select: { id: true, lineOrder: true, productId: true, description: true, qty: true, unit: true, unitPrice: true, lineTotal: true } },
  },
  invoiceList: {
    id: true, companyId: true, referenceNo: true, clientId: true,
    quotationId: true, salesOrderId: true, deliveryNoteId: true, status: true,
    currencyCode: true, totalAmount: true, amountPaid: true,
    amountOutstanding: true, invoiceDate: true, dueDate: true, ebm: true,
    createdById: true, createdAt: true, updatedAt: true,
    client: { select: { id: true, name: true, code: true, tin: true } },
    lines: { select: { id: true, lineOrder: true, productId: true, productName: true, productCode: true, description: true, qty: true, unit: true, unitPrice: true, lineTotal: true } },
  },
});

function normalizeId(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'object' && value._id !== undefined) return String(value._id);
  if (typeof value === 'object' && value.id !== undefined) return String(value.id);
  return String(value);
}

function uniqueIds(values = [], selector) {
  const ids = [];
  const seen = new Set();
  for (const value of values) {
    const selected = typeof selector === 'function' ? selector(value) : value;
    const id = normalizeId(selected);
    if (id === null || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

function mapRecordsById(records = [], key = '_id') {
  const recordsById = new Map();
  for (const record of records) {
    if (!record) continue;
    const id = normalizeId(record[key] ?? record._id ?? record.id);
    if (id !== null) recordsById.set(id, record);
  }
  return recordsById;
}

async function bulkLoadRecords(model, ids, options = {}) {
  const normalizedIds = uniqueIds(ids);
  if (normalizedIds.length === 0) return [];

  const {
    idField = 'id',
    where = {},
    select,
    batchSize,
    concurrency = 4,
  } = options;
  const delegate = typeof model === 'string' ? dbClient()[model] : model;
  if (!delegate || typeof delegate.findMany !== 'function') {
    throw new TypeError('model must be a Prisma delegate or model name');
  }

  const context = getReadContext();
  const maxBatch = Math.min(
    MAX_BATCH_SIZE,
    parseBoundedLimit(batchSize, {
      defaultLimit: Math.min(MAX_BATCH_SIZE, normalizedIds.length),
      maxLimit: MAX_BATCH_SIZE,
      name: 'batchSize',
    }),
  );
  assertReadLimit(maxBatch, context, { name: 'batchSize', maxRows: context.maxRows });
  const chunks = [];
  for (let index = 0; index < normalizedIds.length; index += maxBatch) {
    chunks.push(normalizedIds.slice(index, index + maxBatch));
  }

  const workerCount = Math.max(1, Math.min(Number(concurrency) || 1, 8));
  const results = new Array(chunks.length);
  let cursor = 0;
  async function worker() {
    while (cursor < chunks.length) {
      const index = cursor;
      cursor += 1;
      const chunk = chunks[index];
      results[index] = await delegate.findMany({
        where: { ...where, [idField]: { in: chunk } },
        take: chunk.length,
        ...(select ? { select } : {}),
      });
    }
  }
  await Promise.all(Array.from({ length: Math.min(workerCount, chunks.length) }, worker));
  return results.flat();
}

function parseInteger(value, name) {
  if (value === undefined || value === null || value === '') return null;
  if (!/^[0-9]+$/.test(String(value))) {
    throw new RangeError(`${name} must be a positive integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new RangeError(`${name} must be a positive integer`);
  }
  return parsed;
}

function validatePaginationParams(query = {}, options = {}) {
  const defaultPage = options.defaultPage ?? DEFAULT_PAGE;
  const defaultLimit = options.defaultLimit ?? DEFAULT_LIMIT;
  const maxLimit = options.maxLimit ?? MAX_LIMIT;
  if (!Number.isInteger(defaultPage) || defaultPage < 1) throw new RangeError('defaultPage must be positive');
  if (!Number.isInteger(defaultLimit) || defaultLimit < 1) throw new RangeError('defaultLimit must be positive');
  if (!Number.isInteger(maxLimit) || maxLimit < 1 || maxLimit < defaultLimit) {
    throw new RangeError('maxLimit must be at least defaultLimit');
  }

  const page = parseInteger(query.page, 'page') ?? defaultPage;
  const requestedLimit = parseInteger(query.limit, 'limit') ?? defaultLimit;
  if (requestedLimit > maxLimit) throw new RangeError(`limit must not exceed ${maxLimit}`);

  return {
    page,
    limit: requestedLimit,
    skip: (page - 1) * requestedLimit,
  };
}

function validateCursorValue(cursor) {
  if (cursor === undefined || cursor === null || cursor === '') return null;
  if (typeof cursor !== 'string') throw new TypeError('cursor must be a string');
  const decoded = decodeCursor(cursor);
  if (!decoded) throw new RangeError('cursor is invalid');
  return decoded;
}

module.exports = {
  DEFAULT_PAGE,
  DEFAULT_LIMIT,
  MAX_LIMIT,
  SELECT_SHAPES,
  normalizeId,
  uniqueIds,
  mapRecordsById,
  bulkLoadRecords,
  validatePaginationParams,
  validateCursorValue,
};
