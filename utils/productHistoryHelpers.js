const { toIdString } = require('./objectId');

const REF_FIELDS = ['category', 'supplier', 'preferredSupplier', 'defaultWarehouse', 'createdBy'];

function slimProductForHistory(product) {
  const o = product && typeof product.toObject === 'function' ? product.toObject() : { ...(product || {}) };
  delete o.history;
  delete o.__mutable;
  delete o.isLowStock;
  delete o.availableStock;
  delete o.save;
  delete o.toObject;
  delete o.toJSON;
  delete o.lean;
  for (const ref of REF_FIELDS) {
    if (o[ref] && typeof o[ref] === 'object') {
      o[ref] = toIdString(o[ref]._id || o[ref].id || o[ref]);
    }
  }
  return o;
}

function buildProductHistoryChanges(oldSnap, newBody) {
  const skip = new Set([
    'history', '__v', '_id', 'company', 'createdAt', 'updatedAt',
    'isLowStock', 'availableStock', '__mutable',
  ]);
  const changes = { old: {}, new: {} };
  for (const key of Object.keys(newBody)) {
    if (skip.has(key)) continue;
    const oldVal = oldSnap[key];
    const newVal = newBody[key];
    if (JSON.stringify(oldVal ?? null) !== JSON.stringify(newVal ?? null)) {
      changes.old[key] = oldVal;
      changes.new[key] = newVal;
    }
  }
  return changes;
}

function sanitizeHistoryEntry(entry) {
  if (!entry || typeof entry !== 'object') return entry;
  const e = { ...entry };
  if (e.changedBy && typeof e.changedBy === 'object') {
    e.changedBy = toIdString(e.changedBy._id || e.changedBy.id || e.changedBy);
  }
  if (e.changes && typeof e.changes === 'object') {
    const changes = { ...e.changes };
    if (changes.old && typeof changes.old === 'object') {
      const old = { ...changes.old };
      delete old.history;
      for (const ref of REF_FIELDS) {
        if (old[ref] && typeof old[ref] === 'object') {
          old[ref] = toIdString(old[ref]._id || old[ref].id || old[ref]);
        }
      }
      changes.old = old;
    }
    if (changes.new && typeof changes.new === 'object') {
      const neu = { ...changes.new };
      delete neu.history;
      changes.new = neu;
    }
    e.changes = changes;
  }
  return e;
}

function sanitizeProductHistory(history) {
  if (!Array.isArray(history)) return [];
  return history.map(sanitizeHistoryEntry);
}

async function enrichProductHistory(history, User) {
  const rows = sanitizeProductHistory(history);
  const ids = [...new Set(rows.map((h) => toIdString(h.changedBy)).filter(Boolean))];
  if (!ids.length) {
    return rows.map((h) => ({
      ...h,
      timestamp: h.timestamp || h.createdAt || null,
    }));
  }
  const users = await User.find({ _id: { $in: ids } }).select('name email');
  const byId = new Map(users.map((u) => [String(u._id), { _id: u._id, name: u.name, email: u.email }]));
  return rows.map((h) => ({
    ...h,
    changedBy: byId.get(String(h.changedBy))
      || (h.changedBy ? { _id: h.changedBy, name: null, email: null } : null),
    timestamp: h.timestamp || h.createdAt || null,
  }));
}

module.exports = {
  slimProductForHistory,
  buildProductHistoryChanges,
  sanitizeProductHistory,
  enrichProductHistory,
};
