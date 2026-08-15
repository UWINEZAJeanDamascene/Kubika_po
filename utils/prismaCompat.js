/**
 * Mongoose-compatibility layer over Prisma for the migrated auth/tenancy models
 * (User, Company, Role).
 *
 * Unmigrated domains still call e.g. `Company.findById(id).select('name').lean()`
 * or `User.find({ company, role: 'admin', isActive: true })`. This module lets
 * models/User.js, models/Company.js and models/Role.js keep that call surface
 * while all reads/writes go to PostgreSQL.
 *
 * Supported query subset (verified against the codebase):
 *   findById / findOne / find / countDocuments / exists / create /
 *   updateOne / updateMany / deleteOne / deleteMany
 *   chainables: .select() .sort() .limit() .skip() .lean() .populate() .session() .exec()
 *   filter operators: $in, $nin, $ne, $gt, $gte, $lt, $lte, $or, $and, $exists
 *
 * Unknown filter fields match nothing (same net behavior as querying a Mongo
 * field that does not exist on any document).
 */

const { Prisma } = require('@prisma/client');
const { prisma } = require('../lib/prisma');
const { getCompanyId } = require('./prismaTenant');
const { createAggregateMethod } = require('./prismaAggregate');
const { generateObjectId } = require('./objectId');

const IMPOSSIBLE = Symbol('impossible-filter');

/** Column and relation names per Prisma model, keyed by the delegate's model name. */
const MODEL_FIELD_NAMES = new Map(
  (Prisma.dmmf?.datamodel?.models || []).map((m) => [m.name, new Set(m.fields.map((f) => f.name))]),
);

/** Relation names only (`include` accepts nothing else), keyed the same way. */
const MODEL_RELATION_NAMES = new Map(
  (Prisma.dmmf?.datamodel?.models || []).map((m) => [
    m.name,
    new Set(m.fields.filter((f) => f.kind === 'object').map((f) => f.name)),
  ]),
);

/** Scalar/enum field names per model, used to honor legacy .select() projections. */
const MODEL_SCALAR_FIELD_NAMES = new Map(
  (Prisma.dmmf?.datamodel?.models || []).map((m) => [
    m.name,
    new Set(m.fields.filter((f) => f.kind !== 'object').map((f) => f.name)),
  ]),
);

/** DateTime column names per model, for coercing date strings on write. */
const MODEL_DATE_FIELDS = new Map(
  (Prisma.dmmf?.datamodel?.models || []).map((m) => [
    m.name,
    new Set(m.fields.filter((f) => f.type === 'DateTime' && f.kind === 'scalar').map((f) => f.name)),
  ]),
);

/** Relation field -> target model, so nested writes can be walked too. */
const MODEL_RELATION_TARGETS = new Map(
  (Prisma.dmmf?.datamodel?.models || []).map((m) => [
    m.name,
    new Map(m.fields.filter((f) => f.kind === 'object').map((f) => [f.name, f.type])),
  ]),
);

const droppedColumnWarnings = new Set();

function warnOnce(tag, message) {
  if (droppedColumnWarnings.has(tag)) return;
  droppedColumnWarnings.add(tag);
  console.warn(message);
}

/**
 * Shared mappers (tenantCreateBase, headerTranslateCreate) always emit columns
 * such as `createdById`, but only some tables carry them — and Prisma rejects the
 * whole write over a single unknown key. Drop what the model does not declare,
 * warning once per model+field so a genuine mapping mistake is still visible.
 */
function stripUnknownColumns(data, delegate, operation) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return data;
  const modelName = delegate && typeof delegate.name === 'string' ? delegate.name : null;
  const known = modelName ? MODEL_FIELD_NAMES.get(modelName) : null;
  if (!known) return data;

  let out = null;
  for (const key of Object.keys(data)) {
    if (known.has(key)) continue;
    if (!out) out = { ...data };
    delete out[key];
    warnOnce(
      `${modelName}.${key}`,
      `[prismaCompat] ${modelName}.${operation}: dropped "${key}" — no such field in the Prisma schema`,
    );
  }
  return out || data;
}

/**
 * HTML date inputs and legacy payloads send `YYYY-MM-DD`, which Prisma rejects
 * ("premature end of input. Expected ISO-8601 DateTime"). Mongoose cast these
 * for us, so do the same for every DateTime column, nested writes included.
 */
function coerceDateInputs(data, modelName) {
  if (!data || typeof data !== 'object' || Array.isArray(data) || !modelName) return data;
  const dateFields = MODEL_DATE_FIELDS.get(modelName);
  const relations = MODEL_RELATION_TARGETS.get(modelName);
  if (!dateFields && !relations) return data;

  let out = null;
  const replace = (key, value) => {
    if (!out) out = { ...data };
    out[key] = value;
  };

  for (const [key, value] of Object.entries(data)) {
    if (dateFields && dateFields.has(key) && typeof value === 'string') {
      const parsed = parseDateInput(value);
      if (parsed !== value) replace(key, parsed);
      continue;
    }
    const target = relations && relations.get(key);
    if (target && value && typeof value === 'object') {
      const nested = coerceNestedWrite(value, target);
      if (nested !== value) replace(key, nested);
    }
  }
  return out || data;
}

function parseDateInput(value) {
  const text = value.trim();
  if (!text) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return new Date(`${text}T00:00:00.000Z`);
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? value : parsed;
}

/** Walk the nested-write shapes Prisma accepts: create / createMany / update / upsert. */
function coerceNestedWrite(value, modelName) {
  if (Array.isArray(value)) {
    const mapped = value.map((entry) => coerceDateInputs(entry, modelName));
    return mapped.some((entry, i) => entry !== value[i]) ? mapped : value;
  }

  let out = null;
  const replace = (key, next) => {
    if (!out) out = { ...value };
    out[key] = next;
  };

  for (const key of ['create', 'update', 'data']) {
    if (value[key] === undefined) continue;
    const next = Array.isArray(value[key])
      ? coerceNestedWrite(value[key], modelName)
      : coerceDateInputs(value[key], modelName);
    if (next !== value[key]) replace(key, next);
  }
  for (const key of ['createMany', 'upsert', 'connectOrCreate']) {
    if (!value[key] || typeof value[key] !== 'object') continue;
    const next = coerceNestedWrite(value[key], modelName);
    if (next !== value[key]) replace(key, next);
  }
  return out || value;
}

/**
 * Legacy code populates references that exist as plain id columns but have no
 * Prisma relation (Invoice.quotationId, DeliveryNote.invoiceId, ...). Prisma
 * rejects the whole query over one unknown include key, so drop those here and
 * let the caller resolve them with a follow-up query instead.
 */
function pickKnownRelations(include, delegate) {
  if (!include || typeof include !== 'object') return include;
  const modelName = delegate && typeof delegate.name === 'string' ? delegate.name : null;
  const known = modelName ? MODEL_RELATION_NAMES.get(modelName) : null;
  if (!known) return include;

  let out = null;
  for (const key of Object.keys(include)) {
    // Prisma `_count` is a valid include key, not a named relation.
    if (key === '_count' || known.has(key)) continue;
    if (!out) out = { ...include };
    delete out[key];
    warnOnce(
      `${modelName}.include.${key}`,
      `[prismaCompat] ${modelName}: "${key}" is not a Prisma relation — populated with a follow-up query instead`,
    );
  }
  if (!out) return include;
  return Object.keys(out).length ? out : undefined;
}

function toId(value) {
  if (value == null) return value;
  if (typeof value === 'object' && value._id) return String(value._id);
  return String(value);
}

function translateOperatorObject(value, isIdField) {
  const out = {};
  for (const [op, v] of Object.entries(value)) {
    switch (op) {
      case '$in':
        out.in = (v || []).map((x) => (isIdField ? toId(x) : x));
        break;
      case '$nin':
        out.notIn = (v || []).map((x) => (isIdField ? toId(x) : x));
        break;
      case '$ne':
        if (v == null) return IMPOSSIBLE;
        out.not = isIdField ? toId(v) : v;
        break;
      case '$gt': out.gt = v; break;
      case '$gte': out.gte = v; break;
      case '$lt': out.lt = v; break;
      case '$lte': out.lte = v; break;
      case '$exists':
        // Prisma rejects `{ not: null }`; filter in memory via IMPOSSIBLE fallback.
        if (v) return IMPOSSIBLE;
        out.equals = null;
        break;
      case '$regex':
        out.contains = String(v).replace(/^\^|\$$/g, '');
        if (value.$options && String(value.$options).includes('i')) out.mode = 'insensitive';
        break;
      case '$options':
        break;
      default:
        return IMPOSSIBLE;
    }
  }
  return out;
}

/**
 * Translate a Mongo filter into a Prisma `where`, using fieldMap:
 *   { mongoField: { target: 'prismaField', isId: true } }
 * Returns IMPOSSIBLE when the filter can never match.
 */
function isObjectId(value) {
  return value != null
    && typeof value === 'object'
    && (value._bsontype === 'ObjectId' || value.constructor?.name === 'ObjectId');
}

function translateFilter(filter, fieldMap) {
  if (!filter || Object.keys(filter).length === 0) return {};
  const where = {};
  for (const [key, rawValue] of Object.entries(filter)) {
    if (key === '$or' || key === '$and') {
      const clauses = [];
      for (const sub of rawValue || []) {
        const translated = translateFilter(sub, fieldMap);
        if (translated !== IMPOSSIBLE) clauses.push(translated);
      }
      if (key === '$or') {
        if (!clauses.length) return IMPOSSIBLE;
        where.OR = clauses;
      } else {
        if (clauses.length !== (rawValue || []).length) return IMPOSSIBLE;
        where.AND = clauses;
      }
      continue;
    }

    const mapping = fieldMap[key];
    if (!mapping) return IMPOSSIBLE;

    let value = rawValue;
    if (mapping.isId && value != null && (typeof value !== 'object' || isObjectId(value))) {
      value = toId(value);
    } else if (value !== null && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date) && !isObjectId(value)) {
      value = translateOperatorObject(value, mapping.isId);
      if (value === IMPOSSIBLE) return IMPOSSIBLE;
    } else if (mapping.isId && value != null) {
      value = toId(value);
    } else {
      value = coerceQueryScalar(value);
    }
    if (mapping.transform) {
      const transformed = mapping.transform(value);
      if (transformed === IMPOSSIBLE) return IMPOSSIBLE;
      Object.assign(where, transformed);
      continue;
    }
    where[mapping.target] = value;
  }
  return where;
}

function translateSort(sort, fieldMap = {}) {
  function mapField(field) {
    if (field === '_id') return 'id';
    if (field.includes('.')) {
      const m = fieldMap[field];
      if (m && m.target) return m.target;
      return null;
    }
    const m = fieldMap[field];
    if (m && m.target) return m.target;
    return field;
  }
  if (!sort) return undefined;
  if (typeof sort === 'string') {
    return sort.split(/\s+/).filter(Boolean).map((token) => {
      const desc = token.startsWith('-');
      const field = token.replace(/^-/, '');
      const mapped = mapField(field);
      if (!mapped) return null;
      return { [mapped]: desc ? 'desc' : 'asc' };
    }).filter(Boolean);
  }
  return Object.entries(sort).map(([field, dir]) => {
    const mapped = mapField(field);
    if (!mapped) return null;
    return { [mapped]: dir === -1 || dir === 'desc' ? 'desc' : 'asc' };
  }).filter(Boolean);
}

function coerceQueryScalar(value) {
  if (value === 'true') return true;
  if (value === 'false') return false;
  return value;
}

/**
 * Ref targets for document-level `doc.populate('client lines.product createdBy')`.
 * Prisma shims have no Mongoose schema to read `ref:` from, so resolution is by
 * conventional field name (mirrors plugins/postgresRefPlugin.js for Mongo docs).
 */
const DOC_POPULATE_REFS = {
  client: 'Client',
  supplier: 'Supplier',
  warehouse: 'Warehouse',
  fromWarehouse: 'Warehouse',
  toWarehouse: 'Warehouse',
  product: 'Product',
  category: 'Category',
  company: 'Company',
  user: 'User',
  createdBy: 'User',
  updatedBy: 'User',
  approvedBy: 'User',
  rejectedBy: 'User',
  cancelledBy: 'User',
  performedBy: 'User',
  receivedBy: 'User',
  requestedBy: 'User',
  employee: 'Employee',
  bankAccount: 'BankAccount',
  bankAccountId: 'BankAccount',
  account: 'ChartOfAccount',
  assetAccountId: 'ChartOfAccount',
  accumDepreciationAccountId: 'ChartOfAccount',
  depreciationExpenseAccountId: 'ChartOfAccount',
  categoryId: 'AssetCategory',
  departmentId: 'Department',
  supplierId: 'Supplier',
  quotation: 'Quotation',
  invoice: 'Invoice',
  salesOrder: 'SalesOrder',
  purchaseOrder: 'PurchaseOrder',
  deliveryNote: 'DeliveryNote',
  pickPack: 'PickPack',
  assignedTo: 'User',
  journalEntry: 'JournalEntry',
  journalEntryId: 'JournalEntry',
  recordedBy: 'User',
  expense_account_id: 'ChartOfAccount',
  bank_account_id: 'BankAccount',
  petty_cash_fund_id: 'PettyCashFloat',
  department_id: 'Department',
};

/** Models exported as named members of an aggregate module. */
const REF_MODEL_SOURCES = {
  BankAccount: 'BankAccount',
  PettyCashFloat: 'PettyCash',
};

function loadRefModel(name) {
  try {
    const mod = require(`../models/${REF_MODEL_SOURCES[name] || name}`);
    if (mod && typeof mod.find === 'function') return mod;
    if (mod && mod[name] && typeof mod[name].find === 'function') return mod[name];
    return null;
  } catch (e) {
    return null;
  }
}

function normalizePopulateSpec(paths, select) {
  const list = Array.isArray(paths) ? paths : [paths];
  const out = [];
  for (const entry of list) {
    if (!entry) continue;
    if (typeof entry === 'object') {
      if (entry.path) out.push({ path: entry.path, select: entry.select });
      continue;
    }
    for (const p of String(entry).split(/\s+/).filter(Boolean)) {
      out.push({ path: p, select });
    }
  }
  return out;
}

/** Collect { parent, key } holders for a dotted path, descending through arrays. */
function collectDocHolders(node, parts, out) {
  if (node == null || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const item of node) collectDocHolders(item, parts, out);
    return;
  }
  const [head, ...rest] = parts;
  if (!rest.length) {
    out.push({ parent: node, key: head });
    return;
  }
  collectDocHolders(node[head], rest, out);
}

function applyDocSelect(doc, select) {
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

async function populateDocPaths(doc, spec) {
  for (const { path, select } of spec) {
    const parts = String(path).split('.');
    const refName = DOC_POPULATE_REFS[parts[parts.length - 1]];
    if (!refName) continue;
    const Model = loadRefModel(refName);
    if (!Model || typeof Model.find !== 'function') continue;

    const holders = [];
    collectDocHolders(doc, parts, holders);
    if (!holders.length) continue;

    const ids = [...new Set(
      holders
        .map(({ parent, key }) => parent[key])
        .filter((v) => v != null && typeof v !== 'object')
        .map(String),
    )];
    if (!ids.length) continue;

    let rows;
    try {
      rows = await Model.find({ _id: { $in: ids } });
    } catch (err) {
      console.warn(`[prismaCompat] populate('${path}') failed:`, err && err.message ? err.message : err);
      continue;
    }

    // attachPopulate so nested populate keeps working, e.g.
    //   await deliveryNote.salesOrder.populate('quotation', 'referenceNo')
    const byId = new Map((rows || []).map((r) => [String(r._id), attachPopulate(applyDocSelect(r, select))]));
    for (const { parent, key } of holders) {
      const value = parent[key];
      if (value == null || typeof value === 'object') continue;
      const found = byId.get(String(value));
      if (found) parent[key] = found;
    }
  }
  return doc;
}

function attachPopulate(doc, config) {
  if (!doc || typeof doc !== 'object' || typeof doc.populate === 'function') return doc;
  doc.populate = async function populate(paths, select) {
    const spec = normalizePopulateSpec(paths, select);
    if (!spec.length) return doc;
    return populateDocPaths(doc, spec);
  };
  return doc;
}

/**
 * Attach the model's own document methods (`schema.methods` in Mongoose) to a
 * wrapped row. They are non-enumerable so they stay out of toObject(), JSON
 * responses and update payloads.
 */
function attachDocMethods(doc, config) {
  const methods = config && config.instanceMethods;
  if (!doc || typeof doc !== 'object' || !methods) return doc;
  for (const [name, fn] of Object.entries(methods)) {
    if (typeof fn !== 'function' || typeof doc[name] === 'function') continue;
    Object.defineProperty(doc, name, {
      value: fn.bind(doc),
      enumerable: false,
      writable: true,
      configurable: true,
    });
  }
  return doc;
}

function addLegacyDocMethods(doc) {
  if (!doc || typeof doc !== 'object' || typeof doc.toObject === 'function') return doc;
  doc.toObject = () => {
    const o = { ...doc };
    delete o.toObject;
    delete o.toJSON;
    delete o.lean;
    delete o.save;
    delete o.populate;
    delete o.__mutable;
    return o;
  };
  doc.lean = () => doc.toObject();
  doc.toJSON = () => doc.toObject();
  return doc;
}
function wrapMutableDoc(apiDoc, config) {
  if (!apiDoc || !config.mutable || apiDoc.__mutable) return apiDoc;
  const doc = { ...apiDoc, __mutable: true };

  // Controllers replace `doc.lines` wholesale before saving. Remember the array
  // we loaded so save() can tell a line edit from an untouched header update and
  // only rewrite child rows when they actually changed.
  Object.defineProperty(doc, '__loadedLines', {
    value: doc.lines,
    writable: true,
    enumerable: false,
    configurable: true,
  });
  Object.defineProperty(doc, '__loadedStatus', {
    value: doc.status,
    writable: true,
    enumerable: false,
    configurable: true,
  });

  doc.toObject = () => {
    const o = { ...doc };
    delete o.save;
    delete o.toObject;
    delete o.toJSON;
    delete o.lean;
    delete o.populate;
    delete o.__mutable;
    return o;
  };
  doc.lean = () => doc.toObject();
  doc.toJSON = () => doc.toObject();

  // Mongoose subdocument Array#id(id) compatibility for embedded lines.
  if (Array.isArray(doc.lines) && typeof doc.lines.id !== 'function') {
    Object.defineProperty(doc.lines, 'id', {
      value(id) {
        const sid = String(id);
        return doc.lines.find((l) => String(l._id) === sid || String(l.id) === sid || String(l.lineId) === sid) || null;
      },
      enumerable: false,
      configurable: true,
    });
  }

  doc.save = async function save() {
    const prevStatus = doc.__loadedStatus;
    if (typeof config.beforeSave === 'function') {
      await config.beforeSave(doc, { prevStatus });
    }
    const id = doc._id;
    const plain = typeof doc.toObject === 'function' ? doc.toObject() : doc;
    const raw = config.docToUpdate ? config.docToUpdate(doc) : config.translateUpdate({ $set: plain });
    const delegate = config.delegate();
    const stripped = stripUnknownColumns(raw, delegate, 'save');
    const lines = await rewrittenLines(doc, config);
    const payload = coerceDateInputs(
      lines ? { ...stripped, lines: { deleteMany: {}, create: lines } } : stripped,
      typeof delegate.name === 'string' ? delegate.name : null,
    );
    const row = await config.delegate().update({
      where: { id: String(id) },
      data: payload,
      // Without the include, saving a document would strip its lines/relations.
      include: config.include ? config.include([]) : undefined,
    });
    const next = config.toApi(row);
    Object.keys(doc).forEach((k) => delete doc[k]);
    // wrapResult, not wrapMutableDoc: .save() must not strip .populate() off the doc.
    Object.assign(doc, wrapResult(next, config));
    doc.__loadedLines = doc.lines;
    doc.__loadedStatus = doc.status;
    if (typeof config.afterSave === 'function') {
      await config.afterSave(doc, { prevStatus });
    }
    return doc;
  };

  doc.deleteOne = async function deleteOne() {
    const id = doc._id || doc.id;
    if (!id) return { acknowledged: true, deletedCount: 0 };
    await config.delegate().delete({ where: { id: String(id) } });
    return { acknowledged: true, deletedCount: 1 };
  };

  return doc;
}

/**
 * Line payloads for a doc whose `lines` were replaced since it was loaded, in
 * the shape the model's own create mapper produces. Returns null when the lines
 * are untouched, so ordinary header saves leave the child rows alone.
 */
async function rewrittenLines(doc, config) {
  if (!Array.isArray(doc.lines) || doc.lines === doc.__loadedLines) return null;
  const delegate = config.delegate();
  const relations = MODEL_RELATION_TARGETS.get(delegate && delegate.name);
  if (!relations || !relations.has('lines') || !config.translateCreate) return null;

  // The doc carries its own referenceNo, so no new sequence number is consumed.
  const created = await config.translateCreate(doc.toObject());
  const nested = created && created.lines;
  const create = nested && Array.isArray(nested.create) ? nested.create : [];

  // Never wipe existing child rows with an empty rewrite (e.g. bad toObject / mapper).
  const hadLines = Array.isArray(doc.__loadedLines) && doc.__loadedLines.length > 0;
  if (create.length === 0 && hadLines) {
    console.warn(
      `[prismaCompat] ${delegate.name || 'model'}: refusing empty lines rewrite that would delete ${doc.__loadedLines.length} row(s)`,
    );
    return null;
  }
  return create;
}

function wrapResult(result, config) {
  const wrap = config.mutable
    ? (row) => attachDocMethods(attachPopulate(wrapMutableDoc(row, config), config), config)
    : (row) => attachDocMethods(attachPopulate(addLegacyDocMethods(row), config), config);
  if (Array.isArray(result)) return result.map(wrap);
  return wrap(result);
}

class CompatQuery {
  constructor(executor) {
    this._executor = executor;
    this._options = { sort: null, limit: null, skip: null, populate: [], select: null };
  }

  select(spec) { this._options.select = spec; return this; }
  lean() { return this; }
  session() { return this; }
  setOptions(opts = {}) {
    if (opts.skipTenant !== undefined) this._options.skipTenant = opts.skipTenant;
    if (opts.companyId !== undefined) this._options.companyId = opts.companyId;
    return this;
  }
  populate(path, select) {
    const entries = normalizePopulateSpec(path, select);
    this._options.populate.push(...entries);
    return this;
  }
  sort(s) { this._options.sort = s; return this; }
  limit(n) { this._options.limit = Number(n); return this; }
  skip(n) { this._options.skip = Number(n); return this; }

  exec() { return this._executor(this._options); }
  then(resolve, reject) { return this.exec().then(resolve, reject); }
  catch(fn) { return this.exec().catch(fn); }
  finally(fn) { return this.exec().finally(fn); }
}

/**
 * Build a Mongoose-like model facade backed by Prisma.
 *
 * config = {
 *   delegate: () => prisma.user,
 *   fieldMap: {...},
 *   toApi: (row) => legacyShapedDoc,
 *   translateCreate: async (data) => prismaCreateData,
 *   translateUpdate: (update) => prismaUpdateData,
 *   include: (populate[]) => prismaInclude | undefined,
 * }
 */
function makeCompatModel(config) {
  const delegate = config.delegate;
  const fieldMap = config.fieldMap;
  const toApi = config.toApi;

  function buildInclude(populate) {
    return pickKnownRelations(config.include ? config.include(populate) : undefined, delegate());
  }

  function targetFieldName(field) {
    if (field === '_id') return 'id';
    const mapped = fieldMap && fieldMap[field];
    return (mapped && mapped.target) || field;
  }

  function parseSelectSpec(spec) {
    if (!spec) return null;
    const entries = [];
    if (typeof spec === 'string') {
      for (const token of spec.split(/\s+/).filter(Boolean)) {
        const excluded = token.startsWith('-');
        const clean = token.replace(/^[+-]/, '');
        if (clean) entries.push([clean, excluded ? 0 : 1]);
      }
    } else if (typeof spec === 'object') {
      for (const [key, value] of Object.entries(spec)) entries.push([key, value]);
    }
    if (!entries.length) return null;
    const hasInclude = entries.some(([, value]) => value === 1 || value === true);
    const mode = hasInclude ? 'include' : 'exclude';
    const fields = new Set(entries
      .filter(([, value]) => mode === 'include' ? (value === 1 || value === true) : !(value === 1 || value === true))
      .map(([field]) => targetFieldName(field)));
    return { mode, fields };
  }

  function queryShape(opts = {}, include) {
    const model = modelName();
    const scalarFields = model ? MODEL_SCALAR_FIELD_NAMES.get(model) : null;
    const projection = parseSelectSpec(opts.select);
    if (!projection || !scalarFields) return include ? { include } : {};

    const select = {};
    if (projection.mode === 'include') {
      for (const field of projection.fields) {
        if (scalarFields.has(field)) select[field] = true;
      }
      select.id = true;
      if (config.tenantField && scalarFields.has(config.tenantField)) select[config.tenantField] = true;
    } else {
      for (const field of scalarFields) {
        if (!projection.fields.has(field)) select[field] = true;
      }
      select.id = true;
    }

    for (const [key, value] of Object.entries(include || {})) {
      select[key] = value;
    }

    return { select };
  }

  /**
   * Populate paths the include could not serve - either the model has no such
   * relation, or the include builder does not know the path. Resolved against
   * DOC_POPULATE_REFS with one batched query per path.
   */
  function deferredPopulate(populate = [], include) {
    return (populate || []).filter((entry) => {
      const path = typeof entry === 'object' ? entry && entry.path : entry;
      if (!path) return false;
      const parts = String(path).split('.');
      if (include && include[parts[0]] !== undefined) return false;
      return DOC_POPULATE_REFS[parts[parts.length - 1]] !== undefined;
    });
  }

  function projectionAliases(field) {
    const mapped = targetFieldName(field);
    const aliases = new Set([field, mapped]);
    for (const [source, configEntry] of Object.entries(fieldMap || {})) {
      if (configEntry && configEntry.target === mapped) aliases.add(source);
    }
    if (mapped.endsWith('Id')) aliases.add(mapped.slice(0, -2));
    if (mapped === 'id' || field === 'id') aliases.add('_id');
    if (field === '_id') aliases.add('id');
    return aliases;
  }

  function applyApiProjection(doc, opts = {}) {
    const projection = parseSelectSpec(opts.select);
    if (!projection || !doc || typeof doc !== 'object') return doc;

    const applyOne = (item) => {
      if (!item || typeof item !== 'object') return item;
      if (projection.mode === 'exclude') {
        for (const field of projection.fields) {
          for (const alias of projectionAliases(field)) delete item[alias];
        }
        return item;
      }

      const keep = new Set(['_id', 'id']);
      for (const field of projection.fields) {
        for (const alias of projectionAliases(field)) keep.add(alias);
      }
      for (const key of Object.keys(item)) {
        if (!keep.has(key)) delete item[key];
      }
      return item;
    };

    if (Array.isArray(doc)) return doc.map(applyOne);
    return applyOne(doc);
  }

  /** Wrap rows for the legacy call surface, resolving any deferred populate paths. */
  async function finish(result, opts, include) {
    const wrapped = applyApiProjection(wrapResult(result, config), opts);
    if (!wrapped) return wrapped;
    const spec = normalizePopulateSpec(deferredPopulate(opts.populate, include));
    if (!spec.length) return wrapped;
    await populateDocPaths(wrapped, spec);
    return wrapped;
  }

  function modelName() {
    const name = delegate() && delegate().name;
    return typeof name === 'string' ? name : null;
  }

  async function translateCreate(data) {
    const payload = stripUnknownColumns(await config.translateCreate(data), delegate(), 'create');
    return coerceDateInputs(payload, modelName());
  }

  /**
   * Resolve a Mongo field name to its Prisma column by asking the model's own
   * update mapper, falling back to the filter field map.
   */
  function incrementColumn(key) {
    if (key.includes('.')) return null; // JSON paths cannot be incremented atomically
    try {
      const mapped = config.translateUpdate({ $set: { [key]: 0 } }) || {};
      const columns = Object.keys(mapped);
      if (columns.length === 1) return columns[0];
      if (columns.includes(key)) return key;
    } catch {
      // fall through to the field map
    }
    const mapping = fieldMap && fieldMap[key];
    return (mapping && mapping.target) || null;
  }

  /** Mongo's `$inc` carries no value the mappers can translate, so apply it here. */
  function applyIncrements(update, data) {
    const inc = update && update.$inc;
    if (!inc || typeof inc !== 'object') return data;

    const out = { ...data };
    for (const [key, rawAmount] of Object.entries(inc)) {
      const amount = Number(rawAmount);
      const column = incrementColumn(key);
      if (!column || !Number.isFinite(amount)) {
        warnOnce(`${delegate().name}.$inc.${key}`, `[prismaCompat] ${delegate().name}: cannot $inc "${key}" — no matching column`);
        continue;
      }
      out[column] = { increment: amount };
    }
    return out;
  }

  function translateUpdate(update) {
    const data = applyIncrements(update, config.translateUpdate(update));
    return coerceDateInputs(stripUnknownColumns(data, delegate(), 'update'), modelName());
  }

  async function createOne(data) {
    const createData = await translateCreate(data);
    const row = await delegate().create({ data: createData, include: buildInclude([]) });
    return wrapResult(toApi(row), config);
  }

  /**
   * Mirrors plugins/tenantPlugin.js for models migrated to Postgres: when the
   * request context carries a companyId (set by tenantContextMiddleware) and
   * the filter doesn't already scope by company, inject it. Opt out with
   * `.setOptions({ skipTenant: true })`. Models without `tenantField`
   * (Company, Role) are never auto-scoped — same as the Mongoose plugin,
   * which only applied to schemas with a `company` path.
   */
  function applyTenant(where, opts = {}) {
    if (!config.tenantField || where === IMPOSSIBLE) return where;
    if (opts.skipTenant) return where;
    if (where && where[config.tenantField] !== undefined) return where;
    const companyId = opts.companyId || getCompanyId();
    if (!companyId) return where;
    return { ...where, [config.tenantField]: String(companyId) };
  }

  /**
   * Build a query with the tenant id captured NOW (at call time), not when the
   * thenable executes — the await may happen outside the AsyncLocalStorage scope.
   */
  function tenantQuery(executor) {
    const q = new CompatQuery(executor);
    if (config.tenantField) {
      const cid = getCompanyId();
      if (cid) q._options.companyId = cid;
    }
    return q;
  }

  /**
   * Document Mongo would insert for an upsert that matched nothing: the filter's
   * equality conditions, then `$setOnInsert`, then `$set`. Operator conditions
   * ($gte, $in, ...) contribute nothing, same as Mongo.
   */
  function buildUpsertDoc(filter = {}, update = {}, opts = {}) {
    const doc = {};
    for (const [key, value] of Object.entries(filter)) {
      if (key.startsWith('$')) continue;
      const isOperatorValue = value && typeof value === 'object' && !Array.isArray(value)
        && !(value instanceof Date) && Object.keys(value).some((k) => k.startsWith('$'));
      if (isOperatorValue) continue;
      doc[key] = value;
    }
    Object.assign(doc, update.$setOnInsert || {}, update.$set || {});
    for (const [key, value] of Object.entries(update)) {
      if (!key.startsWith('$')) doc[key] = value;
    }
    if (config.tenantField === 'companyId' && doc.company === undefined && doc.companyId === undefined) {
      const companyId = opts.companyId || getCompanyId();
      if (companyId) doc.company = String(companyId);
    }
    return doc;
  }

  /**
   * Insert half of an upsert. A concurrent writer can win the race and trip a
   * unique constraint (P2002); fall back to updating the row it inserted.
   */
  async function upsertInsert(filter, update, opts, where) {
    try {
      const created = await delegate().create({
        data: await translateCreate(buildUpsertDoc(filter, update, opts)),
        include: buildInclude([]),
      });
      return { row: created, upserted: true };
    } catch (error) {
      if (error && error.code === 'P2002') {
        const existing = await delegate().findFirst({ where, select: { id: true } });
        if (existing) {
          const updated = await delegate().update({
            where: { id: existing.id },
            data: translateUpdate(update),
            include: buildInclude([]),
          });
          return { row: updated, upserted: false };
        }
      }
      throw error;
    }
  }

  const model = {
    findById(id) {
      return tenantQuery(async (opts) => {
        const key = toId(id);
        if (!key) return null;
        const include = buildInclude(opts.populate);
        const row = await delegate().findUnique({ where: { id: key }, ...queryShape(opts, include) });
        // Legacy findById went through the tenant plugin's findOne hook:
        // a document belonging to another company was not visible.
        if (row && config.tenantField && !opts.skipTenant) {
          const companyId = opts.companyId || getCompanyId();
          if (companyId && String(row[config.tenantField]) !== String(companyId)) return null;
        }
        return finish(toApi(row), opts, include);
      });
    },

    findOne(filter = {}) {
      return tenantQuery(async (opts) => {
        if (config.customFind && (filter.$expr || filter.$text || filter.$or)) {
          const row = await config.customFind(filter, opts);
          const include = buildInclude(opts.populate);
          return finish(row ? toApi(row) : null, opts, include);
        }
        const where = applyTenant(translateFilter(filter, fieldMap), opts);
        if (where === IMPOSSIBLE) return null;
        const include = buildInclude(opts.populate);
        const row = await delegate().findFirst({
          where,
          orderBy: translateSort(opts.sort, fieldMap),
          ...queryShape(opts, include),
        });
        return finish(toApi(row), opts, include);
      });
    },

    find(filter = {}) {
      return tenantQuery(async (opts) => {
        if (config.customFind && (filter.$expr || filter.$text || filter.$or)) {
          const rows = await config.customFind(filter, opts, { many: true });
          const include = buildInclude(opts.populate);
          return finish((rows || []).map((r) => toApi(r)), opts, include);
        }
        const where = applyTenant(translateFilter(filter, fieldMap), opts);
        if (where === IMPOSSIBLE) return [];
        const include = buildInclude(opts.populate);
        const rows = await delegate().findMany({
          where,
          orderBy: translateSort(opts.sort, fieldMap),
          take: opts.limit || undefined,
          skip: opts.skip || undefined,
          ...queryShape(opts, include),
        });
        return finish(rows.map((r) => toApi(r)), opts, include);
      });
    },

    countDocuments(filter = {}) {
      return tenantQuery(async (opts) => {
        const where = applyTenant(translateFilter(filter, fieldMap), opts);
        if (where === IMPOSSIBLE) return 0;
        return delegate().count({ where });
      });
    },

    exists(filter = {}) {
      return tenantQuery(async (opts) => {
        const where = applyTenant(translateFilter(filter, fieldMap), opts);
        if (where === IMPOSSIBLE) return null;
        const row = await delegate().findFirst({ where, select: { id: true } });
        return row ? { _id: row.id } : null;
      });
    },

    /**
     * `Model.create(doc)` returns a document and `Model.create([doc, ...])`
     * returns an array, matching Mongoose. Callers pass their session as a
     * second argument; Postgres writes here are not session-scoped, so it is
     * accepted and ignored rather than forcing every call site to change.
     */
    async create(data) {
      if (Array.isArray(data)) {
        const created = [];
        for (const item of data) created.push(await createOne(item));
        return created;
      }
      return createOne(data);
    },

    async insertMany(docs = []) {
      const created = [];
      for (const doc of docs || []) {
        created.push(await createOne(doc));
      }
      return created;
    },

    findOneAndUpdate(filter = {}, update = {}, options = {}) {
      return tenantQuery(async (opts) => {
        const where = applyTenant(translateFilter(filter, fieldMap), opts);
        if (where === IMPOSSIBLE) return null;
        const row = await delegate().findFirst({ where, select: { id: true } });
        if (!row) {
          if (!options.upsert) return null;
          const { row: created } = await upsertInsert(filter, update, opts, where);
          return wrapResult(toApi(created), config);
        }
        const updated = await delegate().update({
          where: { id: row.id },
          data: translateUpdate(update),
          include: buildInclude([]),
        });
        return wrapResult(toApi(updated), config);
      });
    },

    findByIdAndUpdate(id, update = {}, options = {}) {
      return tenantQuery(async () => {
        const key = toId(id);
        if (!key) return null;
        const updated = await delegate().update({
          where: { id: key },
          data: translateUpdate(update),
        }).catch(() => null);
        return wrapResult(updated ? toApi(updated) : null, config);
      });
    },

    findOneAndDelete(filter = {}) {
      return tenantQuery(async (opts) => {
        const where = applyTenant(translateFilter(filter, fieldMap), opts);
        if (where === IMPOSSIBLE) return null;
        const row = await delegate().findFirst({
          where,
          orderBy: translateSort(opts.sort, fieldMap),
          include: buildInclude([]),
        });
        if (!row) return null;
        await delegate().delete({ where: { id: row.id } });
        return wrapResult(toApi(row), config);
      });
    },

    findByIdAndDelete(id) {
      return tenantQuery(async (opts) => {
        const key = toId(id);
        if (!key) return null;
        const row = await delegate().findUnique({ where: { id: key } });
        if (!row) return null;
        if (config.tenantField && !opts.skipTenant) {
          const companyId = opts.companyId || getCompanyId();
          if (companyId && String(row[config.tenantField]) !== String(companyId)) return null;
        }
        await delegate().delete({ where: { id: key } });
        return wrapResult(toApi(row), config);
      });
    },

    async bulkWrite(ops = []) {
      let matched = 0;
      let modified = 0;
      let upserted = 0;
      let deleted = 0;
      let inserted = 0;
      for (const op of ops) {
        if (op.updateOne) {
          const { filter, update, upsert } = op.updateOne;
          const r = await model.updateOne(filter, update, { upsert });
          matched += r.matchedCount || 0;
          modified += r.modifiedCount || 0;
          upserted += r.upsertedCount || 0;
        } else if (op.updateMany) {
          const r = await model.updateMany(op.updateMany.filter, op.updateMany.update);
          matched += r.matchedCount || 0;
          modified += r.modifiedCount || 0;
        } else if (op.insertOne) {
          await model.create(op.insertOne.document || op.insertOne);
          inserted += 1;
        } else if (op.deleteOne) {
          const r = await model.deleteOne(op.deleteOne.filter);
          deleted += r.deletedCount || 0;
        } else if (op.deleteMany) {
          const r = await model.deleteMany(op.deleteMany.filter);
          deleted += r.deletedCount || 0;
        }
      }
      return {
        ok: 1,
        nModified: modified,
        matchedCount: matched,
        modifiedCount: modified,
        upsertedCount: upserted,
        deletedCount: deleted,
        insertedCount: inserted,
      };
    },

    async updateOne(filter = {}, update = {}, options = {}) {
      const opts = config.tenantField ? { companyId: getCompanyId() } : {};
      const where = applyTenant(translateFilter(filter, fieldMap), opts);
      const empty = { acknowledged: true, matchedCount: 0, modifiedCount: 0, upsertedCount: 0 };
      if (where === IMPOSSIBLE) return empty;
      const row = await delegate().findFirst({ where, select: { id: true } });
      if (!row) {
        if (!options.upsert) return empty;
        const { upserted } = await upsertInsert(filter, update, opts, where);
        return upserted
          ? { acknowledged: true, matchedCount: 0, modifiedCount: 0, upsertedCount: 1 }
          : { acknowledged: true, matchedCount: 1, modifiedCount: 1, upsertedCount: 0 };
      }
      await delegate().update({ where: { id: row.id }, data: translateUpdate(update) });
      return { acknowledged: true, matchedCount: 1, modifiedCount: 1, upsertedCount: 0 };
    },

    async updateMany(filter = {}, update = {}) {
      const where = applyTenant(translateFilter(filter, fieldMap));
      if (where === IMPOSSIBLE) return { acknowledged: true, matchedCount: 0, modifiedCount: 0 };
      const result = await delegate().updateMany({ where, data: translateUpdate(update) });
      return { acknowledged: true, matchedCount: result.count, modifiedCount: result.count };
    },

    async deleteOne(filter = {}) {
      const where = applyTenant(translateFilter(filter, fieldMap));
      if (where === IMPOSSIBLE) return { acknowledged: true, deletedCount: 0 };
      const row = await delegate().findFirst({ where, select: { id: true } });
      if (!row) return { acknowledged: true, deletedCount: 0 };
      await delegate().delete({ where: { id: row.id } });
      return { acknowledged: true, deletedCount: 1 };
    },

    async deleteMany(filter = {}) {
      const where = applyTenant(translateFilter(filter, fieldMap));
      if (where === IMPOSSIBLE) return { acknowledged: true, deletedCount: 0 };
      const result = await delegate().deleteMany({ where });
      return { acknowledged: true, deletedCount: result.count };
    },

    /**
     * Mongoose-style static populate used on aggregate results, e.g.:
     *   User.populate(docs, { path: '_id', select: 'name email' })
     * Replaces the id at `path` with the matching (legacy-shaped) document.
     */
    async populate(docs, options) {
      const list = Array.isArray(docs) ? docs : [docs];
      const path = options && options.path;
      if (!path) return docs;
      const ids = [...new Set(list.map((d) => toId(d && d[path])).filter(Boolean))];
      if (!ids.length) return docs;
      const rows = await delegate().findMany({ where: { id: { in: ids } } });
      const byId = new Map(rows.map((r) => [r.id, toApi(r)]));
      for (const doc of list) {
        if (doc && doc[path] != null) {
          doc[path] = byId.get(toId(doc[path])) ?? doc[path];
        }
      }
      return docs;
    },

    aggregate: createAggregateMethod({
      delegate,
      fieldMap,
      toApi,
      include: config.include,
    }),
  };

  return asConstructibleModel(model, config);
}

/** Everything on a document except the helper methods the shim attaches. */
function plainDocData(doc) {
  const out = {};
  for (const [key, value] of Object.entries(doc)) {
    if (typeof value === 'function' || key === '__mutable' || key === '__persisted') continue;
    out[key] = value;
  }
  return out;
}

/**
 * `new Model(data)` followed by `doc.save()` is used throughout the legacy code
 * (inventory layers, POS invoices, payroll, ...), so the model facade doubles as
 * a constructor: the document inserts on its first save and updates after that.
 */
function asConstructibleModel(model, config) {
  function CompatModel(data = {}) {
    if (!new.target) return model;

    const doc = { ...data };
    if (!doc._id) doc._id = generateObjectId();
    doc.__persisted = false;

    doc.toObject = () => plainDocData(doc);
    doc.toJSON = () => doc.toObject();
    doc.lean = () => doc.toObject();

    doc.save = async function save() {
      const payload = doc.toObject();
      const saved = doc.__persisted
        ? await model.findByIdAndUpdate(doc._id, { $set: payload })
        : await model.create(payload);
      doc.__persisted = true;
      if (saved) {
        for (const [key, value] of Object.entries(plainDocData(saved))) doc[key] = value;
      }
      return doc;
    };

    attachPopulate(doc, config);
    return doc;
  }

  Object.assign(CompatModel, model);
  return CompatModel;
}

/** Prisma rejects `{ not: null }` / `{ not: { equals: null } }`. */
function containsInvalidNullFilter(value) {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) return false;
  if (Object.prototype.hasOwnProperty.call(value, 'not') && value.not === null) return true;
  for (const v of Object.values(value)) {
    if (containsInvalidNullFilter(v)) return true;
  }
  return false;
}

module.exports = {
  makeCompatModel,
  translateFilter,
  translateSort,
  IMPOSSIBLE,
  toId,
  containsInvalidNullFilter,
};
