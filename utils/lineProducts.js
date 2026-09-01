/**
 * Batch-load the products referenced by a set of document lines.
 *
 * The pattern this replaces appears throughout the transactional controllers:
 *
 *   for (const line of invoice.lines) {
 *     const product = await Product.findOne({ _id: line.product, company });
 *     ...
 *   }
 *
 * That is one database round-trip per line. It is invisible on a 2-line test
 * invoice and punishing on a real one — a 30-line goods receipt costs 30
 * sequential round-trips before any work starts, which against a remote
 * database is measured in seconds, not milliseconds.
 *
 * Loading them together changes cost from O(lines) round-trips to exactly one,
 * without changing what the surrounding loop does: callers still iterate lines
 * in order and still decide per line, so validation order, error precedence and
 * short-circuit behaviour are all preserved.
 */

/**
 * Line -> product id, tolerating every shape used in this codebase:
 * a populated document (`line.product._id`), a raw id (`line.product`), or a
 * snake_case column (`line.product_id`).
 */
function lineProductId(line) {
  if (!line) return null;
  const raw = line.product != null ? line.product : line.product_id;
  if (raw == null) return null;
  const id = typeof raw === 'object' ? (raw._id != null ? raw._id : raw.id) : raw;
  return id == null ? null : String(id);
}

/**
 * @param {*} Product  The Product model.
 * @param {Array} lines
 * @param {string} companyId
 * @returns {Promise<Map<string, object>>} product id -> product
 */
async function loadLineProducts(Product, lines, companyId) {
  const ids = [...new Set((lines || []).map(lineProductId).filter(Boolean))];
  if (!ids.length) return new Map();
  const rows = await Product.find({ _id: { $in: ids }, company: companyId });
  return new Map((rows || []).map((p) => [String(p._id), p]));
}

/** Look up a line's product in a map built by loadLineProducts. */
function getLineProduct(map, line) {
  const id = lineProductId(line);
  return id ? (map.get(id) || null) : null;
}

module.exports = { lineProductId, loadLineProducts, getLineProduct };
