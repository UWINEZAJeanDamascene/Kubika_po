/**
 * Bounded-read guard for the legacy Mongoose-only models.
 *
 * Prisma compatibility models enforce the same policy in utils/prismaCompat.
 * This plugin covers the remaining true-Mongoose models until their domains are
 * migrated to PostgreSQL, preventing an accidental unbounded find() from
 * materialising a whole tenant collection in the API process.
 *
 * QUERY_ENFORCE_MAX_ROWS=false keeps the legacy warn-only behaviour while a
 * domain is being migrated. Explicit `.limit()` calls are always respected.
 */
const MAX_ROWS = Math.min(5000, Math.max(1, Number(process.env.QUERY_MAX_ROWS) || 500));
const ENFORCE = String(process.env.QUERY_ENFORCE_MAX_ROWS || 'true').toLowerCase() !== 'false';
const reported = new Set();

function callSite() {
  const stack = (new Error().stack || '').split('\n').slice(3);
  return (stack.find((line) => !line.includes('maxRowsPlugin.js') && !line.includes('node:internal')) || 'unknown').trim();
}

function report(modelName, count) {
  const site = callSite();
  const key = `${modelName}:${site}`;
  if (reported.has(key)) return;
  reported.add(key);
  console.warn(
    `[unbounded-read] ${modelName}.find() returned more than ${MAX_ROWS} rows (${count}+) — `
    + `${ENFORCE ? `capped at ${MAX_ROWS}` : 'warn mode'}; add pagination at ${site}`,
  );
}

module.exports = function maxRowsPlugin(schema) {
  schema.pre('find', function boundedFind(next) {
    const options = this.getOptions ? this.getOptions() : {};
    if (options.skipMaxRows || options.allowUnbounded || !ENFORCE) return next();
    const explicitLimit = Number(options.limit);
    if (Number.isFinite(explicitLimit) && explicitLimit > 0) return next();
    this.limit(MAX_ROWS + 1);
    return next();
  });

  schema.post('find', function boundedFindResult(docs) {
    if (!Array.isArray(docs) || docs.length <= MAX_ROWS) return;
    report(this.model?.modelName || 'unknown', docs.length);
    if (ENFORCE) docs.splice(MAX_ROWS);
  });

  schema.post('find', function reportWarnOnly(docs) {
    if (ENFORCE || !Array.isArray(docs) || docs.length <= MAX_ROWS) return;
    report(this.model?.modelName || 'unknown', docs.length);
  });
};
