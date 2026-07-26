/**
 * Global Mongoose plugin: populate() interception for migrated refs.
 *
 * User, Company and Role now live in PostgreSQL (Prisma). Unmigrated Mongo
 * documents still hold CHAR(24) id strings in fields declared with
 * `ref: 'User' | 'Company' | 'Role'`, and ~160 call sites do
 * `.populate('createdBy', 'name email')` etc.
 *
 * This plugin removes those populate instructions before the Mongo query
 * runs, then hydrates the referenced documents from PostgreSQL afterwards,
 * preserving Mongoose populate semantics (id replaced by doc, missing -> null,
 * `select` respected, `_id` always kept).
 *
 * Populates for refs that are still Mongo-backed pass through untouched.
 */

// Lazy to avoid require cycles at module load.
const PG_MODELS = {
  User: () => require('../models/User'),
  Company: () => require('../models/Company'),
  Role: () => require('../models/Role'),
  Category: () => require('../models/Category'),
  Product: () => require('../models/Product'),
  Warehouse: () => require('../models/Warehouse'),
  Client: () => require('../models/Client'),
  Supplier: () => require('../models/Supplier'),
  ChartOfAccount: () => require('../models/ChartOfAccount'),
  Department: () => require('../models/Department'),
  StockMovement: () => require('../models/StockMovement'),
  InventoryBatch: () => require('../models/InventoryBatch'),
  StockTransfer: () => require('../models/StockTransfer'),
  StockAudit: () => require('../models/StockAudit'),
  JournalEntry: () => require('../models/JournalEntry'),
  ReorderPoint: () => require('../models/ReorderPoint'),
  BankAccount: () => require('../models/BankAccount'),
  Employee: () => require('../models/Employee'),
  FixedAsset: () => require('../models/FixedAsset'),
  AssetCategory: () => require('../models/AssetCategory'),
  Budget: () => require('../models/Budget'),
  BudgetLine: () => require('../models/BudgetLine'),
  Project: () => require('../models/Project'),
  EBMDevice: () => require('../models/EBMDevice'),
};

function refForPath(schema, path) {
  const schemaType = schema.path(path);
  if (schemaType) {
    if (schemaType.options && schemaType.options.ref) return schemaType.options.ref;
    if (schemaType.caster && schemaType.caster.options && schemaType.caster.options.ref) {
      return schemaType.caster.options.ref;
    }
    return undefined;
  }
  // Descend into subdocument arrays / nested schemas (e.g. 'items.received_by')
  const idx = path.indexOf('.');
  if (idx > 0) {
    const head = schema.path(path.slice(0, idx));
    if (head && head.schema) return refForPath(head.schema, path.slice(idx + 1));
  }
  return undefined;
}

function rawGet(doc, key) {
  if (doc == null) return undefined;
  if (doc._doc && Object.prototype.hasOwnProperty.call(doc._doc, key)) return doc._doc[key];
  return doc[key];
}

function rawSet(doc, key, value) {
  if (doc._doc) doc._doc[key] = value;
  else doc[key] = value;
}

/** Collect { parent, key } holders for a dotted path, descending through arrays. */
function collectHolders(node, parts, out) {
  if (node == null) return;
  if (Array.isArray(node)) {
    for (const item of node) collectHolders(item, parts, out);
    return;
  }
  const [head, ...rest] = parts;
  if (!rest.length) {
    out.push({ parent: node, key: head });
    return;
  }
  collectHolders(rawGet(node, head), rest, out);
}

function applySelect(doc, select) {
  if (!doc || !select) return doc;
  let fields;
  if (typeof select === 'string') {
    fields = select.split(/\s+/).filter((f) => f && !f.startsWith('-') && !f.startsWith('+'));
  } else if (typeof select === 'object') {
    fields = Object.keys(select).filter((k) => select[k]);
  }
  if (!fields || !fields.length) return doc;
  const out = { _id: doc._id };
  for (const f of fields) {
    if (doc[f] !== undefined) out[f] = doc[f];
  }
  return out;
}

async function hydrateFromPostgres(docs, pgPopulates) {
  const list = Array.isArray(docs) ? docs : [docs];
  if (!list.length || list[0] == null) return;

  for (const { path, select, ref } of pgPopulates) {
    const holders = [];
    for (const doc of list) collectHolders(doc, path.split('.'), holders);
    if (!holders.length) continue;

    const ids = new Set();
    for (const { parent, key } of holders) {
      const value = rawGet(parent, key);
      if (value == null) continue;
      if (Array.isArray(value)) value.forEach((v) => v != null && ids.add(String(v._id || v)));
      else ids.add(String(value._id || value));
    }
    if (!ids.size) continue;

    const Model = PG_MODELS[ref]();
    const rows = await Model.find({ _id: { $in: [...ids] } });
    const byId = new Map(rows.map((r) => [String(r._id), applySelect(r, select)]));

    for (const { parent, key } of holders) {
      const value = rawGet(parent, key);
      if (value == null) continue;
      if (Array.isArray(value)) {
        rawSet(parent, key, value.map((v) => byId.get(String(v && (v._id || v))) ?? null).filter(Boolean));
      } else {
        rawSet(parent, key, byId.get(String(value._id || value)) ?? null);
      }
    }
  }
}

module.exports = function postgresRefPlugin(schema) {
  schema.pre(/^find/, function interceptPgPopulates() {
    const populateMap = this._mongooseOptions && this._mongooseOptions.populate;
    if (!populateMap) return;

    const pgPopulates = [];
    for (const key of Object.keys(populateMap)) {
      const opts = populateMap[key] || {};
      const path = opts.path || key;
      const ref = opts.model || refForPath(schema, path);
      if (ref && PG_MODELS[typeof ref === 'string' ? ref : ref.modelName]) {
        pgPopulates.push({
          path,
          select: opts.select,
          ref: typeof ref === 'string' ? ref : ref.modelName,
        });
        delete populateMap[key];
      }
    }
    if (pgPopulates.length) this._pgPopulates = pgPopulates;
  });

  schema.post(/^find/, async function attachPgPopulates(result) {
    if (!this._pgPopulates || result == null) return;
    try {
      await hydrateFromPostgres(result, this._pgPopulates);
    } catch (err) {
      console.warn('[postgresRefPlugin] populate hydration failed:', err && err.message ? err.message : err);
    }
  });
};
