/**
 * In-memory MongoDB aggregation executor for Prisma-backed model shims.
 * Supports the pipeline patterns used by dashboard services.
 */

const LOOKUP_MODELS = {
  products: () => require('../models/Product'),
  clients: () => require('../models/Client'),
  suppliers: () => require('../models/Supplier'),
  warehouses: () => require('../models/Warehouse'),
};

// This legacy compatibility shim is for low-volume pipelines only. Never let
// an unbounded tenant read become an invisible Node.js heap/event-loop outage.
const AGG_MAX_ROWS = Math.max(1, Number(process.env.AGG_MAX_ROWS || 50000));
const AGG_TELEMETRY = process.env.AGG_TELEMETRY === 'true';

function modelLabel(config) {
  if (config.modelName) return config.modelName;
  const source = typeof config.delegate === 'function' ? Function.prototype.toString.call(config.delegate) : '';
  const match = source.match(/prisma\.([A-Za-z_$][\w$]*)/);
  return match ? match[1] : 'unknown';
}

function aggregateLimitError(config, matchStage) {
  const error = new Error(`Aggregate on ${modelLabel(config)} exceeds the ${AGG_MAX_ROWS.toLocaleString()} row safety limit. Use a SQL/Prisma aggregate or add a narrower filter.`);
  error.name = 'AggregateRowLimitError';
  error.code = 'AGGREGATE_ROW_LIMIT';
  error.status = 413;
  error.aggregate = { model: modelLabel(config), match: matchStage, maxRows: AGG_MAX_ROWS };
  return error;
}

function emitTelemetry(config, metrics, error) {
  if (!AGG_TELEMETRY && !error) return;
  const payload = {
    event: 'prisma_compat_aggregate',
    model: modelLabel(config),
    rowsFetched: metrics.rowsFetched,
    durationMs: Date.now() - metrics.startedAt,
    capped: Boolean(error && error.code === 'AGGREGATE_ROW_LIMIT'),
  };
  if (error) payload.error = error.code || error.message;
  console.warn(`[aggregate] ${JSON.stringify(payload)}`);
}

function normalizeId(v) {
  if (v == null) return v;
  if (typeof v === 'object' && v._id != null) return String(v._id);
  if (typeof v === 'object' && v.constructor?.name === 'ObjectId') return String(v);
  return String(v);
}

function toNumber(v) {
  if (v == null) return 0;
  if (typeof v === 'number') return v;
  if (typeof v === 'string') return parseFloat(v) || 0;
  if (typeof v === 'object' && typeof v.toString === 'function') return parseFloat(v.toString()) || 0;
  return Number(v) || 0;
}

/**
 * Order-comparable value for $gt/$gte/$lt/$lte.
 *
 * toNumber() cannot rank dates: a Date falls through to
 * `parseFloat(v.toString())` — parseFloat('Fri Jan 15 2091 …') is NaN, so it
 * returns 0 — and an ISO string parses as its year. Both operands collapsing to
 * 0 made `$lt`/`$gt` reject every row (0 < 0) while `$gte`/`$lte` accepted every
 * row (0 <= 0). The latter was invisible because the leading $match had already
 * filtered correctly in Postgres; the former silently emptied any aggregate
 * with a strict date bound.
 */
function toComparable(v) {
  if (v instanceof Date) return v.getTime();
  if (typeof v === 'string') {
    // Only ISO-like strings — a plain numeric string must stay numeric.
    if (/^\d{4}-\d{2}-\d{2}([T ]|$)/.test(v)) {
      const t = Date.parse(v);
      if (!Number.isNaN(t)) return t;
    }
  }
  if (v && typeof v === 'object' && typeof v.getTime === 'function') {
    const t = v.getTime();
    if (!Number.isNaN(t)) return t;
  }
  return toNumber(v);
}

function getPath(obj, path) {
  if (path == null) return undefined;
  if (typeof path === 'string' && path.startsWith('$')) {
    if (path.startsWith('$$')) return undefined;
    return getPath(obj, path.slice(1));
  }
  const parts = String(path).split('.');
  let cur = obj;
  for (const p of parts) {
    if (cur == null) return undefined;
    cur = cur[p];
  }
  return cur;
}

function evalExpr(expr, root, vars = {}) {
  if (expr == null) return null;
  if (typeof expr === 'string' && expr.startsWith('$$')) {
    return getPath(vars, expr.slice(2));
  }
  if (typeof expr === 'string' && expr.startsWith('$')) {
    return getPath(root, expr.slice(1));
  }
  if (typeof expr !== 'object') return expr;
  // A Date is an object with no own enumerable keys, so the generic
  // "walk the object" fallback at the bottom turned it into `{}` — every
  // comparison against a date literal in $expr/$cond then compared against 0.
  if (expr instanceof Date) return expr;
  if (Array.isArray(expr)) return expr.map((e) => evalExpr(e, root, vars));

  if (expr.$toDouble) return toNumber(evalExpr(expr.$toDouble, root, vars));
  if (expr.$toInt) return Math.trunc(toNumber(evalExpr(expr.$toInt, root, vars)));
  if (expr.$dateToString) {
    const dateVal = evalExpr(expr.$dateToString.date, root, vars);
    const d = dateVal ? new Date(dateVal) : null;
    if (!d || Number.isNaN(d.getTime())) return null;
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }
  if (expr.$ifNull) {
    const [a, b] = expr.$ifNull;
    const v = evalExpr(a, root, vars);
    return v == null ? evalExpr(b, root, vars) : v;
  }
  if (expr.$round) {
    const [val, dec = 0] = expr.$round;
    const n = toNumber(evalExpr(val, root, vars));
    const f = 10 ** dec;
    return Math.round(n * f) / f;
  }
  if (expr.$multiply) {
    return expr.$multiply.reduce((p, e) => p * toNumber(evalExpr(e, root, vars)), 1);
  }
  if (expr.$subtract) {
    const [a, b] = expr.$subtract;
    return toNumber(evalExpr(a, root, vars)) - toNumber(evalExpr(b, root, vars));
  }
  if (expr.$divide) {
    const [a, b] = expr.$divide;
    const den = toNumber(evalExpr(b, root, vars));
    return den === 0 ? 0 : toNumber(evalExpr(a, root, vars)) / den;
  }
  if (expr.$add) {
    return expr.$add.reduce((s, e) => s + toNumber(evalExpr(e, root, vars)), 0);
  }
  if (expr.$cond) {
    if (Array.isArray(expr.$cond)) {
      const [cond, thenV, elseV] = expr.$cond;
      return evalExpr(cond, root, vars) ? evalExpr(thenV, root, vars) : evalExpr(elseV, root, vars);
    }
    const { if: cond, then: thenV, else: elseV } = expr.$cond;
    return evalExpr(cond, root, vars) ? evalExpr(thenV, root, vars) : evalExpr(elseV, root, vars);
  }
  if (expr.$let) {
    const nextVars = { ...vars };
    for (const [k, v] of Object.entries(expr.$let.vars || {})) {
      nextVars[k] = evalExpr(v, root, vars);
    }
    return evalExpr(expr.$let.in, root, nextVars);
  }
  if (expr.$arrayElemAt) {
    const [arrExpr, idxExpr] = expr.$arrayElemAt;
    const arr = evalExpr(arrExpr, root, vars);
    const idx = evalExpr(idxExpr, root, vars);
    return Array.isArray(arr) ? arr[idx] : undefined;
  }
  if (expr.$size) {
    const arr = evalExpr(expr.$size, root, vars);
    return Array.isArray(arr) ? arr.length : 0;
  }
  if (expr.$map) {
    const input = evalExpr(expr.$map.input, root, vars);
    const arr = Array.isArray(input) ? input : [];
    const as = expr.$map.as || 'item';
    return arr.map((item) => {
      const itemVars = { ...vars, [as]: item };
      return evalExpr(expr.$map.in, root, itemVars);
    });
  }
  if (expr.$sum != null) {
    if (expr.$sum === 1) return 1;
    const evaluated = evalExpr(expr.$sum, root, vars);
    if (Array.isArray(evaluated)) {
      return evaluated.reduce((sum, value) => sum + toNumber(value), 0);
    }
    return toNumber(evaluated);
  }
  if (expr.$eq) {
    const [a, b] = expr.$eq;
    return evalExpr(a, root, vars) === evalExpr(b, root, vars);
  }
  if (expr.$ne) {
    const [a, b] = expr.$ne;
    return evalExpr(a, root, vars) !== evalExpr(b, root, vars);
  }
  if (expr.$gt) {
    const [a, b] = expr.$gt;
    return toComparable(evalExpr(a, root, vars)) > toComparable(evalExpr(b, root, vars));
  }
  if (expr.$gte) {
    const [a, b] = expr.$gte;
    return toComparable(evalExpr(a, root, vars)) >= toComparable(evalExpr(b, root, vars));
  }
  if (expr.$lt) {
    const [a, b] = expr.$lt;
    return toComparable(evalExpr(a, root, vars)) < toComparable(evalExpr(b, root, vars));
  }
  if (expr.$lte) {
    const [a, b] = expr.$lte;
    return toComparable(evalExpr(a, root, vars)) <= toComparable(evalExpr(b, root, vars));
  }
  if (expr.$and) return expr.$and.every((e) => evalExpr(e, root, vars));
  if (expr.$or) return expr.$or.some((e) => evalExpr(e, root, vars));
  if (expr.$in) {
    const [valExpr, arrExpr] = expr.$in;
    const val = normalizeId(evalExpr(valExpr, root, vars));
    const arr = evalExpr(arrExpr, root, vars) || [];
    return arr.map(normalizeId).includes(val);
  }

  const out = {};
  for (const [k, v] of Object.entries(expr)) {
    out[k] = evalExpr(v, root, vars);
  }
  return out;
}

/** Evaluate one operator of a field condition. */
function matchOperator(fieldVal, op, operand, cond) {
  switch (op) {
    case '$in': return operand.map(normalizeId).includes(normalizeId(fieldVal));
    case '$nin': return !operand.map(normalizeId).includes(normalizeId(fieldVal));
    case '$ne':
      return operand == null
        ? fieldVal != null && fieldVal !== undefined
        : normalizeId(fieldVal) !== normalizeId(operand);
    case '$exists':
      return operand
        ? fieldVal != null && fieldVal !== undefined
        : fieldVal == null || fieldVal === undefined;
    case '$gt': return toComparable(fieldVal) > toComparable(operand);
    case '$gte': return toComparable(fieldVal) >= toComparable(operand);
    case '$lt': return toComparable(fieldVal) < toComparable(operand);
    case '$lte': return toComparable(fieldVal) <= toComparable(operand);
    case '$regex': {
      if (fieldVal == null) return false;
      const isRegexObj = operand instanceof RegExp;
      const pattern = isRegexObj ? operand.source : String(operand);
      const flags = cond.$options != null
        ? String(cond.$options)
        : (isRegexObj ? operand.flags : undefined);
      try {
        return new RegExp(pattern, flags).test(String(fieldVal));
      } catch (_err) {
        return false;
      }
    }
    default: return null; // not a recognised operator
  }
}

/** Operators that only modify another operator rather than constraining a value. */
const MATCH_MODIFIERS = new Set(['$options']);

function matchValue(fieldVal, cond) {
  if (cond == null || typeof cond !== 'object' || Array.isArray(cond) || cond instanceof Date) {
    return normalizeId(fieldVal) === normalizeId(cond);
  }

  // Every operator present must hold. This used to `return` on the first one it
  // recognised, so a range like `{ $gte: start, $lte: end }` applied only the
  // lower bound — invisible while Postgres had already applied both, and wrong
  // as soon as the filter fell back to matching in memory.
  let sawOperator = false;
  for (const [op, operand] of Object.entries(cond)) {
    if (!op.startsWith('$') || MATCH_MODIFIERS.has(op)) continue;
    const result = matchOperator(fieldVal, op, operand, cond);
    if (result === null) continue; // unknown operator: leave unconstrained
    sawOperator = true;
    if (!result) return false;
  }

  if (sawOperator) return true;
  return normalizeId(fieldVal) === normalizeId(cond);
}

function matchDoc(doc, filter) {
  if (!filter) return true;
  if (filter.$and) return filter.$and.every((f) => matchDoc(doc, f));
  if (filter.$or) return filter.$or.some((f) => matchDoc(doc, f));
  if (filter.$expr) return !!evalExpr(filter.$expr, doc);

  for (const [key, cond] of Object.entries(filter)) {
    if (key.startsWith('$')) continue;
    const val = key.includes('.') ? getPath(doc, key) : doc[key];
    if (!matchValue(val, cond)) return false;
  }
  return true;
}

function groupKey(doc, idExpr) {
  if (idExpr == null || idExpr === null) return '__null__';
  if (typeof idExpr === 'string' && idExpr.startsWith('$')) {
    const v = getPath(doc, idExpr.slice(1));
    return v == null ? '__null__' : normalizeId(v);
  }
  return JSON.stringify(evalExpr(idExpr, doc));
}

function applyGroup(docs, stage) {
  const groups = new Map();
  for (const doc of docs) {
    const key = groupKey(doc, stage.$group._id);
    if (!groups.has(key)) {
      groups.set(key, { __docs: [], __acc: {} });
    }
    const g = groups.get(key);
    g.__docs.push(doc);
    for (const [outField, expr] of Object.entries(stage.$group)) {
      if (outField === '_id') continue;
      if (!g.__acc[outField]) g.__acc[outField] = { sum: 0, values: [], mode: 'last' };
      const acc = g.__acc[outField];
      if (expr == null || typeof expr !== 'object') {
        acc.mode = 'last';
        acc.values.push(evalExpr(expr, doc));
      } else if (expr.$sum != null) {
        acc.mode = 'sum';
        if (expr.$sum === 1) acc.sum += 1;
        else acc.sum += toNumber(evalExpr(expr.$sum, doc));
      } else if (expr.$addToSet != null) {
        acc.mode = 'set';
        if (!acc.set) acc.set = new Set();
        acc.set.add(normalizeId(evalExpr(expr.$addToSet, doc)));
      } else if (expr.$push != null) {
        acc.mode = 'push';
        if (!acc.list) acc.list = [];
        acc.list.push(evalExpr(expr.$push, doc));
      } else if (expr.$first != null) {
        acc.mode = 'first';
        if (!acc.values.length) acc.values.push(evalExpr(expr.$first, doc));
      } else if (expr.$last != null) {
        acc.mode = 'last';
        acc.values[0] = evalExpr(expr.$last, doc);
      } else {
        acc.mode = 'last';
        acc.values.push(evalExpr(expr, doc));
      }
    }
  }

  const out = [];
  for (const [key, g] of groups.entries()) {
    const row = {};
    if (stage.$group._id == null) row._id = null;
    else if (typeof stage.$group._id === 'string' && stage.$group._id.startsWith('$')) {
      row._id = getPath(g.__docs[0], stage.$group._id.slice(1));
    } else if (stage.$group._id === null) row._id = null;
    else row._id = key === '__null__' ? null : evalExpr(stage.$group._id, g.__docs[0]);

    for (const [field, acc] of Object.entries(g.__acc)) {
      if (acc.mode === 'set' || acc.set) row[field] = [...(acc.set || [])];
      else if (acc.mode === 'push') row[field] = acc.list || [];
      else if (acc.mode === 'first') row[field] = acc.values[0];
      else if (acc.mode === 'last' && acc.values.length) row[field] = acc.values[acc.values.length - 1];
      else row[field] = acc.sum;
    }
    out.push(row);
  }
  return out;
}

async function applyLookup(docs, stage) {
  const Model = LOOKUP_MODELS[stage.$lookup.from]?.();
  if (!Model) return docs;

  const localField = stage.$lookup.localField;
  const as = stage.$lookup.as;
  const ids = [...new Set(docs.map((d) => normalizeId(getPath(d, localField))).filter(Boolean))];
  if (!ids.length) {
    return docs.map((d) => ({ ...d, [as]: [] }));
  }

  const foreign = await Model.find({ _id: { $in: ids } }).lean();
  const byId = new Map(foreign.map((f) => [normalizeId(f._id), f]));
  return docs.map((d) => {
    const id = normalizeId(getPath(d, localField));
    return { ...d, [as]: id && byId.has(id) ? [byId.get(id)] : [] };
  });
}

function applyStage(docs, stage) {
  if (stage.$match) return docs.filter((d) => matchDoc(d, stage.$match));
  if (stage.$unwind) {
    const path = typeof stage.$unwind === 'string'
      ? stage.$unwind.slice(1)
      : stage.$unwind.path?.slice(1);
    const preserve = stage.$unwind?.preserveNullAndEmptyArrays;
    const out = [];
    for (const doc of docs) {
      const arr = getPath(doc, path);
      if (!Array.isArray(arr) || arr.length === 0) {
        if (preserve) out.push({ ...doc, [path.split('.')[0]]: null });
        continue;
      }
      for (const item of arr) {
        const copy = { ...doc };
        const head = path.split('.')[0];
        copy[head] = item;
        out.push(copy);
      }
    }
    return out;
  }
  if (stage.$addFields) {
    return docs.map((doc) => {
      const next = { ...doc };
      for (const [k, expr] of Object.entries(stage.$addFields)) {
        next[k] = evalExpr(expr, next);
      }
      return next;
    });
  }
  if (stage.$project) {
    return docs.map((doc) => {
      const next = {};
      for (const [k, expr] of Object.entries(stage.$project)) {
        if (expr === 1 || expr === true) next[k] = doc[k];
        else if (expr === 0 || expr === false) continue;
        else next[k] = evalExpr(expr, doc);
      }
      return next;
    });
  }
  if (stage.$sort) {
    const entries = Object.entries(stage.$sort);
    return [...docs].sort((a, b) => {
      for (const [field, dir] of entries) {
        const desc = dir === -1 || dir === 'desc';
        const avRaw = getPath(a, field);
        const bvRaw = getPath(b, field);
        const avNum = toNumber(avRaw);
        const bvNum = toNumber(bvRaw);
        const av = (typeof avRaw === 'number' || (typeof avRaw === 'string' && avRaw !== '' && !Number.isNaN(avNum)))
          ? avNum
          : avRaw;
        const bv = (typeof bvRaw === 'number' || (typeof bvRaw === 'string' && bvRaw !== '' && !Number.isNaN(bvNum)))
          ? bvNum
          : bvRaw;
        if (av < bv) return desc ? 1 : -1;
        if (av > bv) return desc ? -1 : 1;
        // Dates / strings
        if (av instanceof Date && bv instanceof Date) {
          if (av.getTime() < bv.getTime()) return desc ? 1 : -1;
          if (av.getTime() > bv.getTime()) return desc ? -1 : 1;
        }
        const as = av == null ? '' : String(av);
        const bs = bv == null ? '' : String(bv);
        if (as < bs) return desc ? 1 : -1;
        if (as > bs) return desc ? -1 : 1;
      }
      return 0;
    });
  }
  if (stage.$limit) return docs.slice(0, stage.$limit);
  if (stage.$group) return applyGroup(docs, stage);
  return docs;
}

function pipelineNeedsLines(pipeline) {
  return pipeline.some((stage) => {
    const uw = stage.$unwind;
    if (uw === '$lines' || uw?.path === '$lines') return true;
    const json = JSON.stringify(stage);
    return json.includes('"$lines"') || json.includes("'$lines'");
  });
}

function detectInclude(pipeline, defaultInclude) {
  const needsLines = pipelineNeedsLines(pipeline);
  if (needsLines) {
    if (defaultInclude) {
      const inc = defaultInclude([]);
      if (inc) return inc;
    }
    return { lines: { orderBy: { lineOrder: 'asc' } } };
  }
  return undefined;
}

async function fetchMatchDocs(matchStage, config, fullPipeline = [], metrics = null) {
  const { translateFilter, IMPOSSIBLE, containsInvalidNullFilter } = require('./prismaCompat');
  const { remapFilterKeys } = require('./aggregateMatch');
  // `config.delegate` is makeCompatModel's tx-aware delegate (see its only
  // caller, prismaCompat's createAggregateMethod({ delegate, ... })), so these
  // reads already join the ambient interactive transaction. Keep it that way:
  // binding this to the plain client would make an aggregate that recomputes a
  // total inside runInTransaction silently read the pre-transaction snapshot.
  // Inspect the full pipeline so $unwind: '$lines' pulls related line rows.
  const include = detectInclude([{ $match: matchStage }, ...fullPipeline], config.include);
  const companyOnly = translateFilter(
    { company: matchStage.company ?? matchStage.companyId ?? matchStage.company_id },
    config.fieldMap,
  );
  if (companyOnly === IMPOSSIBLE) return [];

  // Drop unknown fields (e.g. legacy `reversed`) so Prisma where stays valid.
  const knownMatch = {};
  for (const [k, v] of Object.entries(matchStage || {})) {
    if (k.startsWith('$')) {
      knownMatch[k] = v;
      continue;
    }
    if (config.fieldMap[k] || k === 'company' || k === 'companyId') {
      knownMatch[k] = v;
    }
  }

  const where = translateFilter(knownMatch, config.fieldMap);
  const needsInMemory = where === IMPOSSIBLE || containsInvalidNullFilter(where);

  const fetch = async (where) => {
    // Read one extra row so a group after a truncated read never returns an
    // inaccurate result. The caller receives a clear, retryable 413 instead.
    const rows = await config.delegate().findMany({ where, include, take: AGG_MAX_ROWS + 1 });
    if (metrics) metrics.rowsFetched = rows.length;
    if (rows.length > AGG_MAX_ROWS) throw aggregateLimitError(config, matchStage);
    return rows;
  };

  if (needsInMemory) {
    const rows = await fetch(companyOnly);
    const apiFilter = remapFilterKeys(matchStage, config.fieldMap);
    return rows.map((r) => config.toApi(r)).filter((d) => matchDoc(d, matchStage) || matchDoc(d, apiFilter));
  }

  try {
    const rows = await fetch(where);
    // Still apply original match in memory for fields Prisma couldn't express.
    const apiFilter = remapFilterKeys(matchStage, config.fieldMap);
    return rows.map((r) => config.toApi(r)).filter((d) => matchDoc(d, matchStage) || matchDoc(d, apiFilter));
  } catch (error) {
    if (error && error.code === 'AGGREGATE_ROW_LIMIT') throw error;
    const rows = await fetch(companyOnly);
    const apiFilter = remapFilterKeys(matchStage, config.fieldMap);
    return rows.map((r) => config.toApi(r)).filter((d) => matchDoc(d, matchStage) || matchDoc(d, apiFilter));
  }
}

async function runPipeline(pipeline, seedDocs, config, opts = {}) {
  let docs = seedDocs || [];

  if (!opts.inMemory && pipeline[0]?.$match) {
    docs = await fetchMatchDocs(pipeline[0].$match, config, pipeline.slice(1), opts.metrics);
    pipeline = pipeline.slice(1);
  }

  for (const stage of pipeline) {
    if (stage.$facet) {
      const out = {};
      for (const [name, sub] of Object.entries(stage.$facet)) {
        out[name] = await runPipeline(sub, docs, config, { inMemory: true, metrics: opts.metrics });
      }
      docs = [out];
    } else if (stage.$lookup) {
      docs = await applyLookup(docs, stage);
    } else {
      docs = applyStage(docs, stage);
    }
  }
  return docs;
}

function createAggregateMethod(config) {
  return function aggregate(pipeline, _options = {}) {
    const run = async () => {
      if (!Array.isArray(pipeline)) return [];
      const metrics = { startedAt: Date.now(), rowsFetched: 0 };
      try {
        const result = await runPipeline(pipeline, null, config, { metrics });
        emitTelemetry(config, metrics);
        return result;
      } catch (error) {
        emitTelemetry(config, metrics, error);
        throw error;
      }
    };

    // Mongoose Aggregate is thenable and also exposes .exec() / .session().
    // Controllers await both `Model.aggregate(p)` and `Model.aggregate(p).exec()`.
    const cursor = {
      exec: run,
      session() {
        return cursor;
      },
      allowDiskUse() {
        return cursor;
      },
      option() {
        return cursor;
      },
      then(onFulfilled, onRejected) {
        return run().then(onFulfilled, onRejected);
      },
      catch(onRejected) {
        return run().catch(onRejected);
      },
      finally(onFinally) {
        return run().finally(onFinally);
      },
    };
    return cursor;
  };
}

module.exports = { createAggregateMethod, runPipeline };
