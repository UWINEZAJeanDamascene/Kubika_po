/**
 * Cursor (keyset) pagination for high-volume, append-only lists.
 *
 * WHY, AND WHEN IT ACTUALLY MATTERS
 *
 * Offset pagination makes the database walk and discard every row before the
 * one you want: `OFFSET 100000` reads 100k rows to return 20. Cost grows with
 * how deep you page. Keyset pagination instead says "give me rows after this
 * one", which an index satisfies directly, so page 5000 costs the same as
 * page 1.
 *
 * That difference is invisible until a table is large. On a table of a few
 * thousand rows, offset is fine and simpler. This module exists so the
 * high-volume lists — stock movements, audit trail, journal lines, the EBM
 * queue — can switch without an API break when their volume justifies it.
 *
 * ADDITIVE BY DESIGN
 *
 * Endpoints keep accepting `page`/`limit` exactly as before. A client opts in
 * by sending `cursor` instead, and gets `nextCursor` back. Nothing that
 * currently works changes, which matters because the list screens were built
 * against page numbers.
 *
 * CORRECTNESS
 *
 * The sort key must be unique and stable, or rows are skipped or repeated at
 * page boundaries. A timestamp alone is neither (two rows can share a
 * millisecond), so the cursor always carries a tiebreaker id and the query
 * orders by (sortField, _id). This is the part that is easy to get subtly
 * wrong: a cursor on a non-unique column silently drops records.
 */

/**
 * Encode a cursor from the last row of a page.
 * @param {object} row
 * @param {string} sortField
 * @returns {string|null} opaque base64url cursor
 */
function encodeCursor(row, sortField = 'createdAt') {
  if (!row) return null;
  const value = row[sortField];
  const id = row._id || row.id;
  if (value === undefined || id === undefined) return null;
  const payload = JSON.stringify({
    v: value instanceof Date ? value.toISOString() : value,
    i: String(id),
    f: sortField,
  });
  return Buffer.from(payload, 'utf8').toString('base64url');
}

/**
 * Decode a cursor. Returns null for anything malformed rather than throwing —
 * a bad cursor should fall back to the first page, not 500 the endpoint.
 */
function decodeCursor(cursor) {
  if (!cursor || typeof cursor !== 'string') return null;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (!parsed || parsed.i === undefined || parsed.v === undefined) return null;
    return { value: parsed.v, id: parsed.i, field: parsed.f || 'createdAt' };
  } catch (_) {
    return null;
  }
}

/**
 * Filter fragment selecting rows strictly after the cursor, in the given
 * direction. Merge into the query with `{ ...query, ...cursorFilter(...) }`.
 *
 * For descending order (newest first) "after" means older, hence $lt.
 *
 * @param {string} cursor
 * @param {'asc'|'desc'} direction
 * @returns {object} {} when there is no usable cursor
 */
function cursorFilter(cursor, direction = 'desc') {
  const decoded = decodeCursor(cursor);
  if (!decoded) return {};
  const { value, id, field } = decoded;
  const cmp = direction === 'asc' ? '$gt' : '$lt';
  // Strictly-after on the composite (field, _id) key: either the sort value is
  // past the cursor, or it ties and the id breaks the tie the same way.
  return {
    $or: [
      { [field]: { [cmp]: value } },
      { [field]: value, _id: { [cmp]: id } },
    ],
  };
}

/** Sort spec matching cursorFilter — the tiebreaker must be applied too. */
function cursorSort(sortField = 'createdAt', direction = 'desc') {
  const dir = direction === 'asc' ? 1 : -1;
  return { [sortField]: dir, _id: dir };
}

/**
 * Build the response envelope for a cursor page.
 * Fetch `limit + 1` rows and pass them here: the extra row is what proves
 * whether another page exists, without a count(*) over the whole table.
 */
function cursorPage(rows, limit, sortField = 'createdAt') {
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  return {
    data: page,
    pagination: {
      mode: 'cursor',
      limit,
      hasMore,
      nextCursor: hasMore ? encodeCursor(page[page.length - 1], sortField) : null,
    },
  };
}

/** True when the caller opted into cursor mode. */
function wantsCursor(query = {}) {
  return query.cursor !== undefined || query.mode === 'cursor';
}

module.exports = {
  encodeCursor,
  decodeCursor,
  cursorFilter,
  cursorSort,
  cursorPage,
  wantsCursor,
};
