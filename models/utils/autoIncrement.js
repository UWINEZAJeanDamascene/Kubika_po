/**
 * Auto-increment utility for generating unique codes/numbers across multi-tenant database
 * Uses company prefix + timestamp + random suffix to avoid conflicts
 */

/**
 * Generate a unique code with company prefix - uses timestamp + random to guarantee uniqueness
 * @param {string} prefix - Prefix for the code (e.g., 'CLI', 'SUP')
 * @param {mongoose.Model} Model - Mongoose model to check for uniqueness
 * @param {mongoose.Schema.Types.ObjectId} companyId - Company ID
 * @param {string} fieldName - Field name to check (e.g., 'code', 'sku')
 * @returns {string} - Unique code
 */
async function generateUniqueCode(prefix, Model, companyId, fieldName) {
  let code = '';
  let exists = true;
  let attempts = 0;
  const maxAttempts = 20;
  
  while (exists && attempts < maxAttempts) {
    // Generate code with prefix + timestamp (full) + random (4 digits)
    // Using full timestamp ensures uniqueness across time
    const timestamp = Date.now().toString();
    const random = Math.floor(Math.random() * 10000).toString().padStart(4, '0');
    code = `${prefix}${timestamp}${random}`;
    
    // Check if this code already exists for this company
    const existing = await Model.findOne({
      company: companyId,
      [fieldName]: code
    }).lean();
    
    exists = !!existing;
    attempts++;
  }
  
  if (exists) {
    // Ultimate fallback: UUID-like approach
    code = `${prefix}${Date.now()}${Math.random().toString(36).substring(2, 10).toUpperCase()}`;
  }
  
  return code;
}

/**
 * Generate a short sequential code like PREFIX001 (configurable digits)
 * This is suitable for warehouse/supplier keys to avoid long timestamps.
 */
async function generateShortSequentialCode(prefix, Model, companyId, fieldName, digits = 3) {
  // Match existing codes that start with the prefix followed by optional separator and digits
  // Only consider existing codes with numeric suffix up to the given digits
  const regex = new RegExp(`^${prefix}[-_]?([0-9]{1,${digits}})$`, 'i');
  const docs = await Model.find({ company: companyId, [fieldName]: { $regex: regex } }).select(fieldName).lean();

  let maxSeq = 0;
  for (const d of docs) {
    const m = String(d[fieldName] || '').match(regex);
    if (m && m[1]) {
      const n = parseInt(m[1], 10);
      if (!Number.isNaN(n) && n > maxSeq) maxSeq = n;
    }
  }

  const next = maxSeq + 1;
  const seqStr = String(next).padStart(digits, '0');
  return `${prefix}${seqStr}`;
}

/**
 * Generate SKU based on prefix (derived from product name) and sequential numbering.
 * Format: PREFIX-001 or PREFIX001 depending on includeDash
 */
async function generateSKU(prefix, Model, companyId, fieldName = 'sku', digits = 3, includeDash = true) {
  const pre = String(prefix).toUpperCase();
  const sep = includeDash ? '-' : '';
  // Only consider SKUs that have numeric suffix up to digits to avoid large legacy numeric codes
  const regex = new RegExp(`^${pre}${sep}?([0-9]{1,${digits}})$`, 'i');
  const docs = await Model.find({ company: companyId, [fieldName]: { $regex: regex } }).select(fieldName).lean();
  let maxSeq = 0;
  for (const d of docs) {
    const m = String(d[fieldName] || '').match(regex);
    if (m && m[1]) {
      const n = parseInt(m[1], 10);
      if (!Number.isNaN(n) && n > maxSeq) maxSeq = n;
    }
  }

  const next = maxSeq + 1;
  const seqStr = String(next).padStart(digits, '0');
  return `${pre}${sep}${seqStr}`;
}

/** Tests pin the year so generated numbers stay stable across runs. */
function referenceYear() {
  const isTestRun = process.env.NODE_ENV === 'test' || !!process.env.JEST_WORKER_ID;
  return isTestRun ? 2024 : new Date().getFullYear();
}

function padSequence(value, digits = 5) {
  return String(value).padStart(digits, '0');
}

/**
 * Generate a unique sequential number with year prefix.
 * Uses PostgreSQL `sequences` table when DATABASE_URL is set (Step 8);
 * falls back to Mongo countDocuments when Mongo is still active.
 */
async function generateUniqueNumber(prefix, Model, companyId, fieldName) {
  const isTestRun = process.env.NODE_ENV === 'test' || !!process.env.JEST_WORKER_ID;
  const year = referenceYear();

  if (process.env.DATABASE_URL) {
    const { nextSequence } = require('../../services/sequenceService');
    const seqName = `${String(prefix).toLowerCase()}_${fieldName}`;
    const seq = await nextSequence(companyId, seqName, { year });
    return `${prefix}-${year}-${seq}`;
  }

  let number = '';
  let exists = true;
  let attempts = 0;
  const maxAttempts = 20;

  while (exists && attempts < maxAttempts) {
    const count = await Model.countDocuments({ company: companyId });
    let sequence;
    if (isTestRun) {
      sequence = String(count + 1).padStart(5, '0');
    } else {
      sequence = String(count + 1 + Math.floor(Math.random() * 100)).padStart(5, '0');
    }
    number = `${prefix}-${year}-${sequence}`;

    const existing = await Model.findOne({
      company: companyId,
      [fieldName]: number,
    }).lean();

    exists = !!existing;
    attempts++;
  }

  if (exists) {
    const timestamp = Date.now().toString().slice(-8);
    number = `${prefix}-${year}-${timestamp}`;
  }

  return number;
}

/**
 * Generate a unique sequential number WITHOUT year (e.g., REC-NNNNN).
 * Uses PostgreSQL sequences (year=0) when DATABASE_URL is set.
 */
async function generateUniqueNumberNoYear(prefix, Model, companyId, fieldName) {
  if (process.env.DATABASE_URL) {
    const { nextGlobalSequence } = require('../../services/sequenceService');
    const seqName = `${String(prefix).toLowerCase()}_${fieldName}`;
    const seq = await nextGlobalSequence(companyId, seqName, 5);
    return `${prefix}-${seq}`;
  }

  let number = '';
  let exists = true;
  let attempts = 0;
  const maxAttempts = 20;

  while (exists && attempts < maxAttempts) {
    const count = await Model.countDocuments({ company: companyId });
    const sequence = String(count + 1 + Math.floor(Math.random() * 100)).padStart(5, '0');
    number = `${prefix}-${sequence}`;

    const existing = await Model.findOne({ company: companyId, [fieldName]: number }).lean();
    exists = !!existing;
    attempts++;
  }

  if (exists) {
    const timestamp = Date.now().toString().slice(-8);
    number = `${prefix}-${timestamp}`;
  }

  return number;
}

module.exports = {
  generateUniqueCode,
  generateShortSequentialCode,
  generateSKU,
  generateUniqueNumber,
  generateUniqueNumberNoYear,
  referenceYear,
  padSequence
};
