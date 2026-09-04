const mockDbClient = jest.fn();
jest.mock('../lib/prisma', () => ({ dbClient: mockDbClient }));

const {
  SELECT_SHAPES,
  normalizeId,
  uniqueIds,
  mapRecordsById,
  bulkLoadRecords,
  validatePaginationParams,
  validateCursorValue,
} = require('../utils/queryUtils');
const { encodeCursor } = require('../utils/cursorPagination');

describe('query utilities', () => {
  test('normalizes IDs and removes duplicates while preserving order', () => {
    expect(normalizeId({ _id: 42 })).toBe('42');
    expect(normalizeId({ id: 'second' })).toBe('second');
    expect(uniqueIds([{ _id: 'a' }, { id: 'b' }, 'a', null])).toEqual(['a', 'b']);
  });

  test('deduplicates IDs selected from records', () => {
    expect(uniqueIds([
      { product: 'p1' },
      { product: { _id: 'p2' } },
      { product: 'p1' },
    ], (line) => line.product)).toEqual(['p1', 'p2']);
  });

  test('maps records by normalized ID and skips records without IDs', () => {
    const recordsById = mapRecordsById([
      { _id: 'a', name: 'A' },
      { id: 2, name: 'B' },
      null,
      { name: 'missing' },
    ], '_id');

    expect(recordsById.get('a')).toEqual({ _id: 'a', name: 'A' });
    expect(recordsById.get('2')).toEqual({ id: 2, name: 'B' });
    expect(recordsById.size).toBe(2);
  });

  test('bulk loads unique IDs with tenant filter and projection through Prisma', async () => {
    const delegate = { findMany: jest.fn().mockResolvedValue([{ id: 'p1' }]) };

    await expect(bulkLoadRecords(delegate, ['p1', 'p1', 'p2'], {
      where: { companyId: 'c1' },
      select: { id: true, name: true },
    })).resolves.toEqual([{ id: 'p1' }]);

    expect(delegate.findMany).toHaveBeenCalledWith({
      where: { companyId: 'c1', id: { in: ['p1', 'p2'] } },
      take: 2,
      select: { id: true, name: true },
    });
  });

  test('returns no query for an empty bulk-load input', async () => {
    const delegate = { findMany: jest.fn() };
    await expect(bulkLoadRecords(delegate, [])).resolves.toEqual([]);
    expect(delegate.findMany).not.toHaveBeenCalled();
  });

  test('exposes explicit list projection shapes', () => {
    expect(SELECT_SHAPES.deliveryNoteList).toHaveProperty('referenceNo', true);
    expect(SELECT_SHAPES.pickPackList).toHaveProperty('lines');
    expect(SELECT_SHAPES.salesOrderList).toHaveProperty('client');
    expect(SELECT_SHAPES.invoiceList).toHaveProperty('totalAmount', true);
  });

  test('validates page and limit without silently coercing invalid values', () => {
    expect(validatePaginationParams({})).toEqual({ page: 1, limit: 25, skip: 0 });
    expect(validatePaginationParams({ page: '3', limit: '10' })).toEqual({ page: 3, limit: 10, skip: 20 });
    expect(() => validatePaginationParams({ page: '0' })).toThrow('page must be a positive integer');
    expect(() => validatePaginationParams({ limit: '101' })).toThrow('limit must not exceed 100');
    expect(() => validatePaginationParams({ limit: 'abc' })).toThrow('limit must be a positive integer');
  });

  test('validates opaque cursors and rejects malformed values', () => {
    const cursor = encodeCursor({ createdAt: new Date('2026-01-01T00:00:00.000Z'), _id: 'a' });
    expect(validateCursorValue(cursor)).toEqual({
      value: '2026-01-01T00:00:00.000Z',
      id: 'a',
      field: 'createdAt',
    });
    expect(validateCursorValue(undefined)).toBeNull();
    expect(() => validateCursorValue('bad-cursor')).toThrow('cursor is invalid');
    expect(() => validateCursorValue(42)).toThrow('cursor must be a string');
  });
});
