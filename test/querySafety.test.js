const {
  QuerySafetyError,
  assertReadLimit,
  parseBoundedLimit,
  parseBoundedPage,
  guardResultRows,
  iteratePaged,
} = require('../utils/querySafety');
const { createReadContext, runReadContext, getReadContext } = require('../lib/readContext');

describe('query safety contracts', () => {
  test('rejects invalid and oversized page limits', () => {
    expect(() => parseBoundedLimit('0')).toThrow('limit must be a positive integer');
    expect(() => parseBoundedLimit('not-a-number')).toThrow('limit must be a positive integer');
    expect(() => parseBoundedLimit('101')).toThrow(QuerySafetyError);
    expect(parseBoundedPage({ page: '2', limit: '25' })).toEqual({ page: 2, limit: 25, skip: 25 });
  });

  test('rejects oversized HTTP reads but permits explicit export context', async () => {
    const http = createReadContext({ kind: 'http', maxRows: 100 });
    try {
      assertReadLimit(101, http);
      throw new Error('expected oversized read to fail');
    } catch (error) {
      expect(error).toMatchObject({ code: 'QUERY_LIMIT_EXCEEDED', statusCode: 413 });
    }

    await runReadContext({ kind: 'export', allowLargeRead: true, maxRows: 1000 }, async () => {
      expect(assertReadLimit(1000, getReadContext())).toBe(1000);
    });
  });

  test('guards custom finder result arrays without returning an unsafe set', () => {
    const result = guardResultRows([1, 2, 3], {
      context: createReadContext({ kind: 'http', maxRows: 2 }),
      maxRows: 2,
    });
    expect(result).toEqual([1, 2]);
  });

  test('iterates explicit pages and stops at the final short page', async () => {
    const calls = [];
    const pages = [];
    for await (const page of iteratePaged(async ({ page, limit }) => {
      calls.push({ page, limit });
      return page === 1 ? ['a', 'b'] : ['c'];
    }, { batchSize: 2, maxRows: 10 })) {
      pages.push(page);
    }
    expect(pages).toEqual([['a', 'b'], ['c']]);
    expect(calls).toEqual([{ page: 1, limit: 2 }, { page: 2, limit: 2 }]);
  });
});
