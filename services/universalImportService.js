const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const ExcelJS = require('exceljs');
const { parse } = require('csv-parse/sync');
const { stringify } = require('csv-stringify/sync');
const { getEntityDefinition } = require('./importDefinitions');
const { mapColumns } = require('./importMappingEngine');

const MAX_FILE_SIZE = 10 * 1024 * 1024;
const MAX_ROWS = 10000;
const PROCESSABLE_ENTITY_TYPES = new Set([
  'products',
  'customers',
  'clients',
  'suppliers',
  'employees',
  'chart_of_accounts',
  'opening_stock',
  'fixed_assets',
  'budget',
  'opening_gl_balances',
  'opening_ar_balances',
  'opening_ap_balances',
]);

function getCompanyId(req) {
  return req.company?._id || req.companyId || req.user?.company || req.headers['x-company-id'];
}

function extOf(fileName) {
  return path.extname(fileName || '').toLowerCase();
}

async function parseWorkbook(buffer, fileName, rowLimit = MAX_ROWS + 1) {
  const extension = extOf(fileName);
  if (extension === '.csv') {
    const records = parse(buffer.toString('utf8'), {
      columns: true,
      skip_empty_lines: true,
      trim: true,
      bom: true
    });
    const headers = records.length ? Object.keys(records[0]) : parse(buffer.toString('utf8'), { to_line: 1, bom: true })[0] || [];
    return { headers, rows: records.slice(0, rowLimit) };
  }

  if (extension === '.xls') {
    const XLSX = require('xlsx');
    const workbook = XLSX.read(buffer, { type: 'buffer', cellDates: true });
    const firstSheet = workbook.SheetNames[0];
    if (!firstSheet) return { headers: [], rows: [] };
    const matrix = XLSX.utils.sheet_to_json(workbook.Sheets[firstSheet], { header: 1, raw: false, defval: '' });
    const headers = (matrix[0] || []).map((value) => String(value || '').trim()).filter(Boolean);
    const rows = matrix.slice(1, rowLimit + 1).map((values) => {
      const row = {};
      headers.forEach((header, index) => {
        row[header] = values[index] == null ? '' : String(values[index]).trim();
      });
      return row;
    }).filter((row) => Object.values(row).some((value) => String(value).trim() !== ''));
    return { headers, rows };
  }

  if (extension !== '.xlsx') {
    const error = new Error('Supported formats are CSV, XLSX, and XLS.');
    error.statusCode = 400;
    throw error;
  }

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  const sheet = workbook.worksheets[0];
  if (!sheet) return { headers: [], rows: [] };

  const headerRow = sheet.getRow(1);
  const headers = [];
  headerRow.eachCell({ includeEmpty: false }, (cell) => headers.push(String(cell.value || '').trim()));
  const rows = [];
  const max = Math.min(sheet.rowCount, rowLimit + 1);
  for (let rowIndex = 2; rowIndex <= max; rowIndex++) {
    const row = sheet.getRow(rowIndex);
    const obj = {};
    headers.forEach((header, index) => {
      const cell = row.getCell(index + 1);
      obj[header] = cell.text || (cell.value == null ? '' : String(cell.value));
    });
    if (Object.values(obj).some((value) => String(value).trim() !== '')) rows.push(obj);
  }
  return { headers, rows };
}

function assertUploadLimits(file) {
  if (!file) {
    const error = new Error('Please upload a file.');
    error.statusCode = 400;
    throw error;
  }
  if (file.size > MAX_FILE_SIZE) {
    const error = new Error('File is too large. Maximum upload size is 10MB.');
    error.statusCode = 413;
    throw error;
  }
}

async function parseHeaders(file, entityType) {
  assertUploadLimits(file);
  const parsed = await parseWorkbook(file.buffer, file.originalname, 11);
  if (parsed.rows.length > MAX_ROWS) {
    const error = new Error('Import files are limited to 10,000 rows.');
    error.statusCode = 400;
    throw error;
  }
  const previewRows = parsed.rows.slice(0, 5);
  return {
    fileName: file.originalname,
    headers: parsed.headers,
    previewRows,
    mapping: mapColumns(entityType, parsed.headers, parsed.rows.slice(0, 10))
  };
}

async function parseFullPayload(file, rows) {
  if (Array.isArray(rows)) return rows;
  assertUploadLimits(file);
  const parsed = await parseWorkbook(file.buffer, file.originalname, MAX_ROWS + 1);
  if (parsed.rows.length > MAX_ROWS) {
    const error = new Error('Import files are limited to 10,000 rows.');
    error.statusCode = 400;
    throw error;
  }
  return parsed.rows;
}

function valueFor(row, mapping, fieldKey) {
  const header = typeof mapping[fieldKey] === 'string' ? mapping[fieldKey] : mapping[fieldKey]?.header;
  return header ? row[header] : undefined;
}

function isBlank(value) {
  return value === undefined || value === null || String(value).trim() === '';
}

function parseNumber(value) {
  if (isBlank(value)) return null;
  const normalized = String(value).replace(/,/g, '').trim();
  if (!/^[-+]?\d+(\.\d+)?$/.test(normalized)) return NaN;
  return Number(normalized);
}

function parseDateValue(value) {
  if (isBlank(value)) return null;
  const raw = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return new Date(`${raw}T00:00:00.000Z`);
  const match = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (match) {
    const first = Number(match[1]);
    const second = Number(match[2]);
    const year = Number(match[3]);
    const day = first > 12 ? first : second;
    const month = first > 12 ? second : first;
    return new Date(Date.UTC(year, month - 1, day));
  }
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function paymentTermsFromDays(value) {
  const days = parseNumber(value);
  if (!days || days <= 0) return 'cash';
  if (days <= 7) return 'credit_7';
  if (days <= 15) return 'credit_15';
  if (days <= 30) return 'credit_30';
  if (days <= 45) return 'credit_45';
  return 'credit_60';
}

function buildValidationError(rowNumber, field, message, value) {
  return { row: rowNumber, field, message, value };
}

function duplicateKeyFor(entityType, clean) {
  if (entityType === 'products' && clean.sku) return String(clean.sku).trim().toUpperCase();
  if ((entityType === 'customers' || entityType === 'clients' || entityType === 'suppliers') && clean.tin) return String(clean.tin).trim();
  if (entityType === 'employees' && clean.employeeId) return String(clean.employeeId).trim().toUpperCase();
  if (entityType === 'chart_of_accounts' && clean.accountCode) return String(clean.accountCode).trim();
  return null;
}

function normalizeMatch(value) {
  return String(value || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, ' ');
}

function matchScore(left, right) {
  const a = normalizeMatch(left);
  const b = normalizeMatch(right);
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.includes(b) || b.includes(a)) return 0.9;
  const aWords = new Set(a.split(' '));
  const bWords = new Set(b.split(' '));
  const overlap = [...aWords].filter((word) => bWords.has(word)).length;
  return overlap / Math.max(aWords.size, bWords.size);
}

function bestMatch(value, candidates, text = (candidate) => candidate.name) {
  let best = null;
  for (const candidate of candidates || []) {
    const score = matchScore(value, text(candidate));
    if (!best || score > best.score) best = { candidate, score };
  }
  return best;
}

function quantityUnitFor(unit) {
  const normalized = normalizeMatch(unit);
  if (['kg', 'kilogram', 'kilograms'].includes(normalized)) return 'KGM';
  return 'U';
}

function isWellFormedRraItemClassCode(value) {
  return /^\d{6,14}$/.test(String(value || '').trim());
}

async function buildProductEnrichmentContext(companyId) {
  const Category = require('../models/Category');
  const Warehouse = require('../models/Warehouse');
  const Supplier = require('../models/Supplier');
  const Product = require('../models/Product');
  const EBMItemClass = require('../models/EBMItemClass');
  const EBMCode = require('../models/EBMCode');
  const ChartOfAccount = require('../models/ChartOfAccount');
  const Company = require('../models/Company');

  const [company, categories, warehouses, suppliers, products, itemClasses, ebmCodes, accounts] = await Promise.all([
    Company.findById(companyId).lean(),
    Category.find({ company: companyId }).lean(),
    Warehouse.find({ company: companyId, isActive: { $ne: false } }).lean(),
    Supplier.find({ company: companyId, isActive: { $ne: false } }).lean(),
    Product.find({ company: companyId }).select('brand').lean(),
    EBMItemClass.find({ company: companyId, active: { $ne: false } }).lean(),
    EBMCode.find({ company: companyId, active: { $ne: false } }).lean(),
    ChartOfAccount.find({ company: companyId, code: { $in: ['1400', '5000', '4000'] } }).lean(),
  ]);

  return { company, categories, warehouses, suppliers, products, itemClasses, ebmCodes, accounts };
}

async function enrichProductRow(companyId, clean, context, rowNumber) {
  const warnings = [];
  const categoryMatch = bestMatch(clean.category, context.categories);
  if (categoryMatch && categoryMatch.score >= 0.8) {
    clean.category = categoryMatch.candidate.name;
  } else {
    const general = context.categories.find((category) => normalizeMatch(category.name) === 'general');
    clean.category = general?.name || 'General';
    if (!general) {
      const created = await require('../models/Category').create({
        company: companyId,
        name: 'General',
        description: 'Created automatically during product import',
      });
      context.categories.push(created);
    }
    if (clean.category !== (categoryMatch?.candidate?.name || '')) {
      warnings.push({ field: 'category', message: 'Category was resolved to General because no confident match was found.' });
    }
  }

  const warehouseMatch = bestMatch(
    clean.warehouse,
    context.warehouses,
    (warehouse) => `${warehouse.name || ''} ${warehouse.code || ''} ${warehouse.rraBranchId || ''}`,
  );
  const defaultWarehouse = context.warehouses.find((warehouse) => warehouse.isDefault)
    || context.warehouses.find((warehouse) => normalizeMatch(warehouse.name).includes('main'))
    || context.warehouses[0];
  const selectedWarehouse = warehouseMatch && warehouseMatch.score >= 0.75
    ? warehouseMatch.candidate
    : defaultWarehouse;
  clean.warehouse = selectedWarehouse?.name || null;
  clean.warehouseId = selectedWarehouse?._id || null;
  if (!warehouseMatch && !defaultWarehouse) {
    warnings.push({ field: 'warehouse', message: 'No warehouse exists; create one before importing opening stock.' });
  }

  const supplierMatch = bestMatch(clean.supplier, context.suppliers);
  if (clean.supplier && supplierMatch && supplierMatch.score >= 0.8) {
    clean.supplier = supplierMatch.candidate.name;
    clean.supplierId = supplierMatch.candidate._id;
  } else if (clean.supplier) {
    const Supplier = require('../models/Supplier');
    const draftName = String(clean.supplier).trim();
    const draft = await Supplier.create({
      company: companyId,
      name: draftName,
      code: `IMP-${Date.now().toString(36).toUpperCase().slice(-8)}`,
      contact: {},
      isActive: true,
      notes: 'Draft supplier created automatically during product import; add contact details.',
      customFields: { importNeedsContactInfo: true },
    });
    context.suppliers.push(draft);
    clean.supplierId = draft._id;
    warnings.push({ field: 'supplier', message: `Draft supplier created for ${draftName}; contact details still need completion.` });
  }

  if (clean.brand) {
    const brands = [...new Set(context.products.map((product) => product.brand).filter(Boolean))].map((name) => ({ name }));
    const brandMatch = bestMatch(clean.brand, brands);
    clean.brand = brandMatch && brandMatch.score >= 0.8 ? brandMatch.candidate.name : null;
  }

  const taxDefault = context.company?.is_vat_registered === false ? 'A' : 'B';
  clean.taxTypeCode = String(clean.taxTypeCode || taxDefault).toUpperCase();

  const unit = clean.quantityUnitCode || clean.unit || 'pcs';
  const unitCode = String(clean.quantityUnitCode || '').toUpperCase();
  const quantityCandidates = context.ebmCodes.filter((code) => /quantity|unit|uom|qty/i.test(`${code.codeClassName || ''} ${code.codeClass || ''}`));
  const packagingCandidates = context.ebmCodes.filter((code) => /pack|pkg/i.test(`${code.codeClassName || ''} ${code.codeClass || ''}`));
  const quantityMatch = clean.quantityUnitCode
    ? bestMatch(clean.quantityUnitCode, quantityCandidates.length ? quantityCandidates : context.ebmCodes, (code) => `${code.code} ${code.name}`)
    : null;
  clean.quantityUnitCode = quantityMatch && quantityMatch.score >= 0.8
    ? quantityMatch.candidate.code
    : (context.ebmCodes.find((code) => code.code === (unitCode || quantityUnitFor(unit)))?.code
      || quantityCandidates[0]?.code
      || quantityUnitFor(unit));
  const packagingMatch = clean.packagingUnitCode
    ? bestMatch(clean.packagingUnitCode, packagingCandidates.length ? packagingCandidates : context.ebmCodes, (code) => `${code.code} ${code.name}`)
    : null;
  clean.packagingUnitCode = packagingMatch && packagingMatch.score >= 0.8
    ? packagingMatch.candidate.code
    : (context.ebmCodes.find((code) => code.code === (String(unit).toLowerCase().includes('kg') ? 'NT' : 'CT'))?.code
      || packagingCandidates[0]?.code
      || (String(unit).toLowerCase().includes('kg') ? 'NT' : 'CT'));

  const suppliedItemClassCode = String(clean.itemClassCode || '').trim();
  const exactClass = context.itemClasses.find((itemClass) => String(itemClass.itemClassCode) === suppliedItemClassCode);
  if (exactClass) {
    clean.itemClassCode = exactClass.itemClassCode;
  } else if (isWellFormedRraItemClassCode(suppliedItemClassCode)) {
    clean.itemClassCode = suppliedItemClassCode;
    warnings.push({
      field: 'itemClassCode',
      message: 'The supplied RRA item classification was preserved but is not in the local cache; verify it during EBM registration.',
    });
  } else {
    const classMatch = bestMatch(`${clean.name} ${clean.description}`, context.itemClasses, (itemClass) => itemClass.itemClassName);
    if (classMatch && classMatch.score >= 0.65) {
      clean.itemClassCode = classMatch.candidate.itemClassCode;
    } else {
      clean.itemClassCode = null;
      warnings.push({ field: 'itemClassCode', blocking: true, message: 'No confident synced RRA item classification was found; review this row before importing.' });
    }
  }

  clean.costingMethod = clean.costingMethod || 'fifo';
  clean.trackingType = clean.trackingType || 'none';
  clean.isStockable = clean.isStockable == null ? true : clean.isStockable;
  clean.barcodeType = clean.barcodeType || 'CODE128';
  const openingQuantity = parseNumber(clean.openingStockQuantity) || 0;
  clean.reorderLevel = isBlank(clean.reorderLevel) ? Math.round(openingQuantity * 0.2 * 100) / 100 : clean.reorderLevel;
  clean.reorderQuantity = isBlank(clean.reorderQuantity) ? clean.reorderLevel : clean.reorderQuantity;

  const category = context.categories.find((candidate) => normalizeMatch(candidate.name) === normalizeMatch(clean.category));
  const accountByCode = new Map(context.accounts.map((account) => [String(account.code), account]));
  clean.inventoryAccount = category?.defaultInventoryAccount || accountByCode.get('1400')?.code || null;
  clean.cogsAccount = category?.defaultCogsAccount || accountByCode.get('5000')?.code || null;
  clean.revenueAccount = category?.defaultRevenueAccount || accountByCode.get('4000')?.code || null;

  return warnings.map((warning) => ({ ...warning, row: rowNumber }));
}

async function detectDuplicate(entityType, companyId, clean) {
  if (entityType === 'products' && clean.sku) {
    const Product = require('../models/Product');
    const existing = await Product.findOne({ company: companyId, sku: String(clean.sku).toUpperCase() }).select('_id sku').lean();
    return existing ? { duplicate: true, key: clean.sku, existingId: existing._id } : { duplicate: false };
  }
  if ((entityType === 'customers' || entityType === 'clients') && clean.tin) {
    const Client = require('../models/Client');
    const existing = await Client.findOne({ company: companyId, taxId: clean.tin }).select('_id taxId').lean();
    return existing ? { duplicate: true, key: clean.tin, existingId: existing._id } : { duplicate: false };
  }
  if (entityType === 'suppliers' && clean.tin) {
    const Supplier = require('../models/Supplier');
    const existing = await Supplier.findOne({ company: companyId, taxId: clean.tin }).select('_id taxId').lean();
    return existing ? { duplicate: true, key: clean.tin, existingId: existing._id } : { duplicate: false };
  }
  if (entityType === 'employees' && clean.employeeId) {
    const Employee = require('../models/Employee');
    const existing = await Employee.findOne({ company: companyId, employeeId: String(clean.employeeId).toUpperCase() }).select('_id employeeId').lean();
    return existing ? { duplicate: true, key: clean.employeeId, existingId: existing._id } : { duplicate: false };
  }
  if (entityType === 'chart_of_accounts' && clean.accountCode) {
    const ChartOfAccount = require('../models/ChartOfAccount');
    const existing = await ChartOfAccount.findOne({ company: companyId, code: clean.accountCode }).select('_id code').lean();
    return existing ? { duplicate: true, key: clean.accountCode, existingId: existing._id } : { duplicate: false };
  }
  return { duplicate: false };
}

function cleanMappedRow(entityType, row, mapping) {
  const definition = getEntityDefinition(entityType);
  const clean = {};
  for (const field of definition.fields) {
    const value = valueFor(row, mapping, field.key);
    clean[field.key] = isBlank(value) ? null : String(value).trim();
  }
  return clean;
}

function validateCleanRow(entityType, clean, rowNumber) {
  const definition = getEntityDefinition(entityType);
  const errors = [];
  const warnings = [];

  for (const field of definition.fields) {
    if (field.required && isBlank(clean[field.key])) {
      errors.push(buildValidationError(rowNumber, field.key, `${field.label} is required - this cell is empty.`, clean[field.key]));
    }
  }

  for (const key of ['sellingPrice', 'costPrice', 'openingStockQuantity', 'reorderLevel', 'creditLimit', 'openingBalance', 'basicSalary', 'debitBalance', 'creditBalance', 'cost', 'accumulatedDepreciation', 'usefulLifeYears', 'budgetedAmount', 'quantity', 'costPerUnit', 'amountOutstanding']) {
    if (!isBlank(clean[key]) && Number.isNaN(parseNumber(clean[key]))) {
      errors.push(buildValidationError(rowNumber, key, `${key} must be a number - found '${clean[key]}'.`, clean[key]));
    }
  }

  if (!isBlank(clean.taxTypeCode) && !['A', 'B', 'C', 'D'].includes(String(clean.taxTypeCode).toUpperCase())) {
    errors.push(buildValidationError(rowNumber, 'taxTypeCode', `Tax type must be A, B, C, or D - found '${clean.taxTypeCode}'.`, clean.taxTypeCode));
  }
  if (!isBlank(clean.tin) && !/^\d{9}$/.test(String(clean.tin))) {
    errors.push(buildValidationError(rowNumber, 'tin', `TIN must be 9 digits - found '${clean.tin}'.`, clean.tin));
  }
  if (!isBlank(clean.email) && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(clean.email))) {
    errors.push(buildValidationError(rowNumber, 'email', `Email must be valid - found '${clean.email}'.`, clean.email));
  }
  if (!isBlank(clean.phone) && !/^(\+250|250|0)?7[2389]\d{7}$/.test(String(clean.phone).replace(/\s+/g, ''))) {
    errors.push(buildValidationError(rowNumber, 'phone', `Phone must be a valid Rwandan number - found '${clean.phone}'.`, clean.phone));
  }
  for (const key of ['hireDate', 'purchaseDate', 'asOfDate', 'dueDate']) {
    if (!isBlank(clean[key]) && !parseDateValue(clean[key])) {
      errors.push(buildValidationError(rowNumber, key, `${key} must be a valid date - found '${clean[key]}'.`, clean[key]));
    }
  }
  if (!isBlank(clean.accountType) && !['asset', 'liability', 'equity', 'revenue', 'expense', 'cogs'].includes(String(clean.accountType).toLowerCase())) {
    errors.push(buildValidationError(rowNumber, 'accountType', `Account type must be Asset, Liability, Equity, Revenue, or Expense - found '${clean.accountType}'.`, clean.accountType));
  }

  if (entityType === 'products' && !isBlank(clean.openingStockQuantity) && (parseNumber(clean.openingStockQuantity) || 0) > 0 && isBlank(clean.warehouse)) {
    errors.push(buildValidationError(rowNumber, 'warehouse', 'Warehouse is required when opening stock quantity is provided.', clean.warehouse));
  }

  if (entityType === 'products') {
    const cost = parseNumber(clean.costPrice);
    const price = parseNumber(clean.sellingPrice);
    if (!isBlank(clean.costPrice) && (cost == null || cost <= 0)) {
      errors.push(buildValidationError(rowNumber, 'costPrice', 'Cost price must be greater than zero when provided.', clean.costPrice));
    }
    if (!isBlank(clean.sellingPrice) && cost != null && price != null && price < cost) {
      errors.push(buildValidationError(rowNumber, 'sellingPrice', 'Selling price must be greater than or equal to cost price.', clean.sellingPrice));
    }
  }

  return { errors, warnings };
}

async function validateImport({ entityType, mapping, rows, file, companyId }) {
  const definition = getEntityDefinition(entityType);
  if (!definition) {
    const error = new Error('Invalid import entity type.');
    error.statusCode = 400;
    throw error;
  }
  const fullRows = await parseFullPayload(file, rows);
  const results = [];
  const duplicateGroups = {};
  let debitTotal = 0;
  let creditTotal = 0;
  // Caches for opening stock validation
  const productCache = new Map(); // sku -> product
  const warehouseCache = new Map(); // lower(name) -> warehouse
  const openingKeySeen = new Set(); // productId-warehouseId within file
  const openingExistingCache = new Map(); // key -> true if opening already exists in DB
  const productContext = entityType === 'products' ? await buildProductEnrichmentContext(companyId) : null;
  const fileDuplicateKeys = new Map();

  for (let index = 0; index < fullRows.length; index++) {
    const rowNumber = index + 2;
    const clean = cleanMappedRow(entityType, fullRows[index], mapping);
    const { errors, warnings } = validateCleanRow(entityType, clean, rowNumber);
    if (productContext) {
      const enrichmentWarnings = await enrichProductRow(companyId, clean, productContext, rowNumber);
      for (const warning of enrichmentWarnings) {
        if (warning.blocking) {
          errors.push(buildValidationError(rowNumber, warning.field, warning.message, clean[warning.field]));
        } else {
          warnings.push(warning);
        }
      }
    }
    if (!PROCESSABLE_ENTITY_TYPES.has(entityType)) {
      errors.push(buildValidationError(
        rowNumber,
        '_entity',
        `${definition.label} import is not available yet. No records were written.`,
        entityType,
      ));
    }
    if (entityType === 'opening_gl_balances') {
      debitTotal += parseNumber(clean.debitBalance) || 0;
      creditTotal += parseNumber(clean.creditBalance) || 0;
    }
    // Opening stock specific validation: existing product + warehouse, positive qty, non-negative cost, uniqueness per product/warehouse
    if (entityType === 'opening_stock') {
      const Product = require('../models/Product');
      const Warehouse = require('../models/Warehouse');
      const StockMovement = require('../models/StockMovement');
      const sku = isBlank(clean.productCode) ? null : String(clean.productCode).trim().toUpperCase();
      const warehouseName = isBlank(clean.warehouse) ? null : String(clean.warehouse).trim();
      const qty = parseNumber(clean.quantity);
      const cost = parseNumber(clean.costPerUnit);
      const asOfDateValue = clean.asOfDate;
      let movementDate = null;

      if (qty == null || Number.isNaN(qty) || qty <= 0) {
        errors.push(buildValidationError(rowNumber, 'quantity', 'Quantity must be greater than zero for opening stock.', clean.quantity));
      }
      if (cost != null && !Number.isNaN(cost) && cost < 0) {
        errors.push(buildValidationError(rowNumber, 'costPerUnit', 'Cost per unit cannot be negative.', clean.costPerUnit));
      }

      if (!isBlank(asOfDateValue)) {
        movementDate = parseDateValue(asOfDateValue);
        if (!movementDate) {
          errors.push(buildValidationError(rowNumber, 'asOfDate', 'As-of Date must be valid (DD/MM/YYYY).', asOfDateValue));
        }
      } else {
        movementDate = new Date();
        warnings.push({ field: 'asOfDate', message: 'No date provided — opening stock dated today. If migrating historical data please include As-of Date.' });
      }

      let product = sku ? productCache.get(sku) : null;
      if (sku && !product) {
        product = await Product.findOne({ company: companyId, sku }).select('_id name');
        if (product) productCache.set(sku, product);
      }
      if (!product) {
        errors.push(buildValidationError(rowNumber, 'productCode', 'Product code (SKU) not found. Create products first, then import opening stock.', clean.productCode));
      }

      const warehouseKey = warehouseName ? warehouseName.toLowerCase() : null;
      let warehouse = warehouseKey ? warehouseCache.get(warehouseKey) : null;
      if (warehouseKey && !warehouse) {
        warehouse = await Warehouse.findOne({ company: companyId, name: new RegExp(`^${warehouseName}$`, 'i') }).select('_id name');
        if (warehouse) warehouseCache.set(warehouseKey, warehouse);
      }
      if (!warehouse) {
        errors.push(buildValidationError(rowNumber, 'warehouse', 'Warehouse not found. Create the warehouse first.', clean.warehouse));
      }

      const openingKey = product?._id && warehouse?._id ? `${product._id}-${warehouse._id}` : null;
      if (openingKey && openingKeySeen.has(openingKey)) {
        errors.push(buildValidationError(rowNumber, 'duplicate', 'Duplicate opening stock for the same product and warehouse in this file.', `${product._id}-${warehouse._id}`));
      }

      if (openingKey && !errors.some((err) => err.field === 'productCode' || err.field === 'warehouse')) {
        if (!openingExistingCache.has(openingKey)) {
          const existing = await StockMovement.findOne({ company: companyId, product: product._id, warehouse: warehouse._id }).select('_id');
          openingExistingCache.set(openingKey, !!existing);
        }
        if (openingExistingCache.get(openingKey)) {
          errors.push(buildValidationError(rowNumber, 'existing_stock', 'Stock already exists for this product in this warehouse. If you entered opening stock incorrectly via stock adjustment, you must reverse those entries first through a manual journal entry before importing opening stock here.', openingKey));
        }
      }

      if (product) clean.productId = product._id;
      if (warehouse) clean.warehouseId = warehouse._id;
      if (movementDate) clean.movementDate = movementDate;
      if (openingKey) openingKeySeen.add(openingKey);
    }
    let duplicate = errors.length ? { duplicate: false } : await detectDuplicate(entityType, companyId, clean);
    const fileKey = duplicateKeyFor(entityType, clean);
    if (!errors.length && fileKey) {
      const previousRow = fileDuplicateKeys.get(`${entityType}:${fileKey}`);
      if (previousRow) {
        duplicate = { duplicate: true, key: fileKey, existingId: `file-row-${previousRow}` };
      } else {
        fileDuplicateKeys.set(`${entityType}:${fileKey}`, rowNumber);
      }
    }
    if (duplicate.duplicate) {
      const type = definition.uniqueField || 'record';
      duplicateGroups[type] = duplicateGroups[type] || { field: type, count: 0, keys: [] };
      duplicateGroups[type].count += 1;
      duplicateGroups[type].keys.push(duplicate.key);
    }
    results.push({
      rowNumber,
      source: fullRows[index],
      data: clean,
      valid: errors.length === 0,
      errors,
      warnings,
      duplicate
    });
  }

  if (definition.balancedDebitsCredits && Math.abs(debitTotal - creditTotal) > 0.005) {
    results.forEach((result) => {
      result.valid = false;
      result.errors.push(buildValidationError(result.rowNumber, 'balance', `Total debits (${debitTotal}) must equal total credits (${creditTotal}).`, null));
    });
  }

  const validRows = results.filter((row) => row.valid).length;
  const errorRows = results.length - validRows;

  return {
    entityType,
    totalRows: results.length,
    validRows,
    errorRows,
    duplicateGroups: Object.values(duplicateGroups),
    rows: results,
    summary: `${validRows} rows ready to import. ${errorRows} rows have errors.`
  };
}

async function ensureCategory(companyId, name) {
  const Category = require('../models/Category');
  const categoryName = name || 'General';
  let category = await Category.findOne({ company: companyId, name: categoryName });
  if (!category) category = await Category.create({ company: companyId, name: categoryName, description: 'Created during import' });
  return category._id;
}

async function captureProductOpeningStock(companyId, userId, productId, data) {
  const quantity = parseNumber(data.openingStockQuantity);
  if (quantity == null || quantity <= 0) return false;

  const Warehouse = require('../models/Warehouse');
  const StockMovement = require('../models/StockMovement');
  const OpeningStockService = require('./openingStockService');
  const warehouses = await Warehouse.find({ company: companyId }).lean();
  const requestedName = String(data.warehouse || '').trim().toLowerCase();
  const warehouse = data.warehouseId
    ? warehouses.find((candidate) => String(candidate._id) === String(data.warehouseId))
    : warehouses.find((candidate) => [candidate.name, candidate.code, candidate.rraBranchId]
      .some((value) => String(value || '').trim().toLowerCase() === requestedName));
  if (!warehouse) {
    throw new Error(`Warehouse "${data.warehouse || ''}" not found for opening stock.`);
  }

  const existingOpening = await StockMovement.findOne({
    company: companyId,
    product: productId,
    warehouse: warehouse._id,
    reason: 'initial_stock',
  }).select('_id').lean();
  if (existingOpening) return false;

  await OpeningStockService.createOpeningStock({
    companyId,
    userId,
    productId,
    warehouseId: warehouse._id,
    quantity,
    unitCost: parseNumber(data.costPrice) || 0,
    notes: 'Opening stock included with product import'
  });
  return true;
}

async function linkImportedProductToSupplier(companyId, productId, supplierId, data) {
  if (!supplierId || !productId) return false;

  const Supplier = require('../models/Supplier');
  const StockMovement = require('../models/StockMovement');
  const supplier = await Supplier.findOne({ _id: supplierId, company: companyId });
  if (!supplier) return false;

  const suppliedProducts = Array.isArray(supplier.productsSupplied) ? supplier.productsSupplied : [];
  const alreadyLinked = suppliedProducts.some((id) => String(id) === String(productId));
  if (alreadyLinked) return false;

  suppliedProducts.push(productId);
  supplier.productsSupplied = suppliedProducts;

  const quantity = parseNumber(data.openingStockQuantity) || 0;
  const unitCost = parseNumber(data.costPrice) || 0;
  let importedValue = quantity > 0 ? quantity * unitCost : 0;
  if (!importedValue) {
    const movement = await StockMovement.findOne({
      company: companyId,
      product: productId,
      reason: 'initial_stock',
    }).select('quantity unitCost totalCost').sort({ movementDate: -1 }).lean();
    importedValue = Number(movement?.totalCost) || (Number(movement?.quantity || 0) * Number(movement?.unitCost || 0));
  }
  if (importedValue > 0) supplier.totalPurchases = (Number(supplier.totalPurchases) || 0) + importedValue;
  await supplier.save();
  return true;
}

async function calculateStockFromMovements(companyId, productId) {
  const StockMovement = require('../models/StockMovement');
  const movements = await StockMovement.find({ company: companyId, product: productId })
    .select('type quantity')
    .lean();
  if (!movements.length) return null;
  return movements.reduce((total, movement) => {
    const quantity = Number(movement.quantity) || 0;
    return total + (String(movement.type).toLowerCase() === 'out' ? -quantity : quantity);
  }, 0);
}

async function resolveWarehouseId(companyId, name) {
  if (!name) return null;
  const Warehouse = require('../models/Warehouse');
  const requestedName = String(name).trim().toLowerCase();
  const warehouse = await Warehouse.findOne({ company: companyId, name: new RegExp(`^${requestedName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') }).lean();
  return warehouse?._id || null;
}

async function writeFixedAsset(companyId, userId, data) {
  const FixedAsset = require('../models/FixedAsset');
  const AssetCategory = require('../models/AssetCategory');
  const ChartOfAccount = require('../models/ChartOfAccount');
  const category = await AssetCategory.findOne({ company: companyId, name: data.category }).lean();
  if (!category) throw new Error(`Asset category not found: ${data.category}`);

  const accountCodes = {
    asset: category.defaultAssetAccountCode || '1700',
    accumulated: category.defaultAccumDepreciationAccountCode || '1810',
    expense: category.defaultDepreciationExpenseAccountCode || '5800',
  };
  const accounts = await Promise.all(Object.values(accountCodes).map((code) => ChartOfAccount.findOne({ company: companyId, code }).lean()));
  if (accounts.some((account) => !account)) throw new Error('Required fixed-asset accounts do not exist.');

  const purchaseCost = parseNumber(data.cost);
  const accumulatedDepreciation = parseNumber(data.accumulatedDepreciation);
  const usefulLifeMonths = Math.round(parseNumber(data.usefulLifeYears) * 12);
  if (!purchaseCost || purchaseCost < 0 || !usefulLifeMonths || usefulLifeMonths < 1) {
    throw new Error('Fixed asset cost and useful life must be valid positive values.');
  }

  const asset = new FixedAsset({
    company: companyId,
    name: data.assetName,
    categoryId: category._id,
    assetAccountId: accounts[0]._id,
    assetAccountCode: accountCodes.asset,
    accumDepreciationAccountId: accounts[1]._id,
    accumDepreciationAccountCode: accountCodes.accumulated,
    depreciationExpenseAccountId: accounts[2]._id,
    depreciationExpenseAccountCode: accountCodes.expense,
    purchaseDate: parseDateValue(data.purchaseDate),
    purchaseCost,
    accumulatedDepreciation: accumulatedDepreciation || 0,
    netBookValue: purchaseCost - (accumulatedDepreciation || 0),
    usefulLifeMonths,
    depreciationMethod: String(data.depreciationMethod || 'straight_line').toLowerCase().replace(/\s+/g, '_'),
    location: data.location || null,
    createdBy: userId,
    status: 'in_transit',
  });
  asset.referenceNo = await FixedAsset.generateReferenceNo(companyId);
  await asset.save();
  return { status: 'success', message: 'Created fixed asset.' };
}

async function writeBudgetLine(companyId, userId, data) {
  const Budget = require('../models/Budget');
  const BudgetLine = require('../models/BudgetLine');
  const ChartOfAccount = require('../models/ChartOfAccount');
  const account = await ChartOfAccount.findOne({ company: companyId, code: data.accountCode }).lean();
  if (!account) throw new Error(`Account not found: ${data.accountCode}`);
  const [year, month] = String(data.period || '').split('-').map(Number);
  if (!year || month < 1 || month > 12) throw new Error(`Invalid budget period: ${data.period}`);

  const budgetName = `Imported Budget ${year}`;
  let budget = await Budget.findOne({ company_id: companyId, fiscal_year: year, name: budgetName }).lean();
  if (!budget) {
    budget = await Budget.create({ company: companyId, name: budgetName, fiscal_year: year, type: 'expense', budget_cycle: 'fixed_year', periodType: 'monthly', status: 'draft', amount: 0, created_by: userId });
  }
  const existing = await BudgetLine.findOne({ company_id: companyId, budget_id: budget._id, account_id: account._id, period_month: month, period_year: year }).lean();
  const line = { company_id: companyId, budget_id: budget._id, account_id: account._id, period_month: month, period_year: year, budgeted_amount: parseNumber(data.budgetedAmount), category: '', notes: 'Universal Smart Import' };
  if (existing) await BudgetLine.updateOne({ _id: existing._id, company: companyId }, { $set: line });
  else await BudgetLine.create(line);
  return { status: 'success', message: 'Created budget line.' };
}

async function writeOpeningAr(companyId, userId, data, balances) {
  const Client = require('../models/Client');
  const ARTransactionLedger = require('../models/ARTransactionLedger');
  const { generateObjectId } = require('../utils/objectId');
  const client = await Client.findOne({ company: companyId, name: data.customerIdentifier }).lean();
  if (!client) throw new Error(`Customer not found: ${data.customerIdentifier}`);
  const amount = parseNumber(data.amountOutstanding);
  if (!amount || amount <= 0) throw new Error('Opening AR amount must be greater than zero.');
  const key = String(client._id);
  const current = (balances.get(key) || 0) + amount;
  const sourceId = generateObjectId();
  await Client.updateOne({ _id: client._id, company: companyId }, { $set: { outstandingBalance: current } });
  await ARTransactionLedger.create({ company: companyId, client: client._id, transactionType: 'opening_balance', transactionDate: parseDateValue(data.dueDate) || new Date(), referenceNo: data.invoiceReference || `OPEN-AR-${sourceId}`, description: `Opening AR balance for ${client.name}`, amount, direction: 'increase', clientBalanceAfter: current, invoiceBalanceAfter: amount, sourceType: 'opening_ar', sourceId, sourceReference: data.invoiceReference || null, createdBy: userId, reconciliationStatus: 'verified', metadata: { imported: true } });
  balances.set(key, current);
  return { status: 'success', message: 'Created opening AR balance.' };
}

async function writeOpeningAp(companyId, userId, data, balances) {
  const Supplier = require('../models/Supplier');
  const APTransactionLedger = require('../models/APTransactionLedger');
  const { generateObjectId } = require('../utils/objectId');
  const supplier = await Supplier.findOne({ company: companyId, name: data.supplierIdentifier }).lean();
  if (!supplier) throw new Error(`Supplier not found: ${data.supplierIdentifier}`);
  const amount = parseNumber(data.amountOutstanding);
  if (!amount || amount <= 0) throw new Error('Opening AP amount must be greater than zero.');
  const key = String(supplier._id);
  const current = (balances.get(key) || 0) + amount;
  const sourceId = generateObjectId();
  await APTransactionLedger.create({ company: companyId, supplier: supplier._id, transactionType: 'opening_balance', transactionDate: parseDateValue(data.dueDate) || new Date(), referenceNo: data.invoiceReference || `OPEN-AP-${sourceId}`, description: `Opening AP balance for ${supplier.name}`, amount, direction: 'increase', supplierBalanceAfter: current, sourceType: 'opening_ap', sourceId, sourceReference: data.invoiceReference || null, createdBy: userId, reconciliationStatus: 'verified', metadata: { imported: true } });
  balances.set(key, current);
  return { status: 'success', message: 'Created opening AP balance.' };
}

async function writeOpeningGl(companyId, userId, rows) {
  const ChartOfAccount = require('../models/ChartOfAccount');
  const OpeningBalanceService = require('./OpeningBalanceService');
  const balances = [];
  for (const row of rows) {
    const account = await ChartOfAccount.findOne({ company: companyId, code: row.accountCode }).lean();
    if (!account) throw new Error(`Account not found: ${row.accountCode}`);
    const debit = parseNumber(row.debitBalance) || 0;
    const credit = parseNumber(row.creditBalance) || 0;
    if (debit > 0) balances.push({ account_id: account._id, entry_type: 'debit', amount: debit, description: `Opening balance - ${row.accountCode}` });
    if (credit > 0) balances.push({ account_id: account._id, entry_type: 'credit', amount: credit, description: `Opening balance - ${row.accountCode}` });
  }
  return OpeningBalanceService.import(companyId, { asOfDate: rows[0]?.asOfDate, balances }, userId);
}

function productPayload(companyId, userId, data) {
  const importedUnit = String(data.quantityUnitCode || '').toUpperCase();
  const unit = importedUnit === 'KGM' ? 'kg' : importedUnit === 'U' ? 'pcs' : (data.unit || 'pcs');
  return {
    company: companyId,
    name: data.name,
    sku: String(data.sku).toUpperCase(),
    description: data.description,
    unit,
    currentStock: 0,
    lowStockThreshold: parseNumber(data.reorderLevel) || 0,
    reorderQuantity: parseNumber(data.reorderQuantity) || 0,
    averageCost: parseNumber(data.costPrice) || 0,
    costPrice: parseNumber(data.costPrice) || 0,
    sellingPrice: parseNumber(data.sellingPrice) || 0,
    costingMethod: data.costingMethod || 'fifo',
    trackingType: data.trackingType || 'none',
    isStockable: data.isStockable !== false,
    barcodeType: data.barcodeType || 'CODE128',
    brand: data.brand || null,
    inventoryAccount: data.inventoryAccount || null,
    cogsAccount: data.cogsAccount || null,
    revenueAccount: data.revenueAccount || null,
    taxCode: String(data.taxTypeCode || 'A').toUpperCase(),
    ebm: {
      taxTyCd: String(data.taxTypeCode || 'A').toUpperCase(),
      itemClassCd: data.itemClassCode,
      pkgUnitCd: data.packagingUnitCode,
      qtyUnitCd: data.quantityUnitCode,
      itemClassCode: data.itemClassCode,
      taxTypeCode: String(data.taxTypeCode || 'A').toUpperCase(),
      packagingUnitCode: data.packagingUnitCode,
      quantityUnitCode: data.quantityUnitCode
    },
    createdBy: userId,
    ...(data.supplierId ? { supplier: data.supplierId } : {})
  };
}

async function upsertRow(entityType, companyId, userId, data, duplicateAction, context = {}) {
  if (entityType === 'products') {
    const Product = require('../models/Product');
    const warehouseId = data.warehouseId || await resolveWarehouseId(companyId, data.warehouse);
    const payload = productPayload(companyId, userId, data);
    if (warehouseId) payload.defaultWarehouse = warehouseId;
    payload.category = await ensureCategory(companyId, data.category);
    const existing = await Product.findOne({ company: companyId, sku: payload.sku });
    if (existing && duplicateAction === 'skip') {
      if (warehouseId && String(existing.defaultWarehouse || '') !== String(warehouseId)) {
        await Product.updateOne({ _id: existing._id, company: companyId }, { $set: { defaultWarehouse: warehouseId } });
      }
      const stockCaptured = await captureProductOpeningStock(companyId, userId, existing._id, data);
      await linkImportedProductToSupplier(companyId, existing._id, payload.supplier, data);
      return { status: 'skipped', message: stockCaptured ? 'Skipped duplicate product; captured opening stock.' : 'Skipped duplicate product.' };
    }
    if (existing && duplicateAction === 'update') {
      const updatePayload = { ...payload };
      delete updatePayload.currentStock;
      const movementStock = await calculateStockFromMovements(companyId, existing._id);
      if (movementStock != null) updatePayload.currentStock = movementStock;
      await Product.updateOne({ _id: existing._id, company: companyId }, { $set: updatePayload });
      const stockCaptured = await captureProductOpeningStock(companyId, userId, existing._id, data);
      await linkImportedProductToSupplier(companyId, existing._id, payload.supplier, data);
      return { status: 'success', message: stockCaptured ? 'Updated duplicate product and captured opening stock.' : 'Updated duplicate product.' };
    }
    if (existing && duplicateAction !== 'create') return { status: 'skipped', message: 'Skipped duplicate product.' };
    const product = await Product.create(payload);
    await captureProductOpeningStock(companyId, userId, product._id, data);
    await linkImportedProductToSupplier(companyId, product._id, payload.supplier, data);
    return { status: 'success', message: 'Created product.' };
  }

  if (entityType === 'customers' || entityType === 'clients') {
    const Client = require('../models/Client');
    const payload = {
      company: companyId,
      name: data.name,
      taxId: data.tin,
      contact: { email: data.email, phone: data.phone, address: data.address },
      paymentTerms: paymentTermsFromDays(data.paymentTermsDays),
      creditLimit: parseNumber(data.creditLimit) || 0,
      outstandingBalance: parseNumber(data.openingBalance) || 0,
      createdBy: userId
    };
    const existing = data.tin ? await Client.findOne({ company: companyId, taxId: data.tin }) : null;
    if (existing && duplicateAction === 'skip') return { status: 'skipped', message: 'Skipped duplicate customer.' };
    if (existing && duplicateAction === 'update') {
      await Client.updateOne({ _id: existing._id, company: companyId }, { $set: payload });
      return { status: 'success', message: 'Updated duplicate customer.' };
    }
    await Client.create(payload);
    return { status: 'success', message: 'Created customer.' };
  }

  if (entityType === 'suppliers') {
    const Supplier = require('../models/Supplier');
    const payload = {
      company: companyId,
      name: data.name,
      taxId: data.tin,
      contact: { email: data.email, phone: data.phone, address: data.address },
      paymentTerms: paymentTermsFromDays(data.paymentTermsDays),
      createdBy: userId
    };
    const existing = data.tin ? await Supplier.findOne({ company: companyId, taxId: data.tin }) : null;
    if (existing && duplicateAction === 'skip') return { status: 'skipped', message: 'Skipped duplicate supplier.' };
    if (existing && duplicateAction === 'update') {
      await Supplier.updateOne({ _id: existing._id, company: companyId }, { $set: payload });
      return { status: 'success', message: 'Updated duplicate supplier.' };
    }
    await Supplier.create(payload);
    return { status: 'success', message: 'Created supplier.' };
  }

  if (entityType === 'employees') {
    const Employee = require('../models/Employee');
    const payload = {
      company: companyId,
      employeeId: String(data.employeeId).toUpperCase(),
      firstName: data.firstName,
      lastName: data.lastName,
      nationalId: data.nationalId,
      email: data.email,
      phone: data.phone,
      department: data.department,
      position: data.position,
      hireDate: parseDateValue(data.hireDate),
      bankAccount: data.bankAccount,
      rssbRegistrationNumber: data.rssbNumber,
      currentSalary: {
        basicSalary: parseNumber(data.basicSalary) || 0,
        effectiveDate: parseDateValue(data.hireDate) || new Date()
      },
      createdBy: userId,
      updatedBy: userId
    };
    const existing = await Employee.findOne({ company: companyId, employeeId: payload.employeeId });
    if (existing && duplicateAction === 'skip') return { status: 'skipped', message: 'Skipped duplicate employee.' };
    if (existing && duplicateAction === 'update') {
      await Employee.updateOne({ _id: existing._id, company: companyId }, { $set: payload });
      return { status: 'success', message: 'Updated duplicate employee.' };
    }
    if (existing && duplicateAction === 'create') {
      payload.employeeId = `${payload.employeeId}-COPY-${Date.now().toString().slice(-5)}`;
    }
    await Employee.create(payload);
    return { status: 'success', message: 'Created employee.' };
  }

  if (entityType === 'chart_of_accounts') {
    const ChartOfAccount = require('../models/ChartOfAccount');
    const type = String(data.accountType).toLowerCase() === 'cogs' ? 'cogs' : String(data.accountType).toLowerCase();
    const parent = data.parentAccountCode ? await ChartOfAccount.findOne({ company: companyId, code: data.parentAccountCode }) : null;
    const payload = {
      company: companyId,
      code: data.accountCode,
      name: data.accountName,
      type,
      parent_id: parent?._id || null,
      customFields: { importDescription: data.description },
      createdBy: userId
    };
    const existing = await ChartOfAccount.findOne({ company: companyId, code: payload.code });
    if (existing && duplicateAction === 'skip') return { status: 'skipped', message: 'Skipped duplicate account.' };
    if (existing && duplicateAction === 'update') {
      await ChartOfAccount.updateOne({ _id: existing._id, company: companyId }, { $set: payload });
      return { status: 'success', message: 'Updated duplicate account.' };
    }
    if (existing && duplicateAction === 'create') {
      payload.code = `${payload.code}-COPY-${Date.now().toString().slice(-5)}`;
    }
    await ChartOfAccount.create(payload);
    return { status: 'success', message: 'Created account.' };
  }

  if (entityType === 'opening_stock') {
    const OpeningStockService = require('./openingStockService');
    const quantity = parseNumber(data.quantity) || 0;
    const unitCost = parseNumber(data.costPerUnit) || 0;
    if (!data.productId || !data.warehouseId) {
      throw new Error('Opening stock import missing product or warehouse reference.');
    }
    await OpeningStockService.createOpeningStock({
      companyId,
      userId,
      productId: data.productId,
      warehouseId: data.warehouseId,
      quantity,
      unitCost,
      notes: 'Opening stock import',
      movementDate: data.movementDate || new Date()
    });
    return { status: 'success', message: 'Captured opening stock.' };
  }

  if (entityType === 'fixed_assets') return writeFixedAsset(companyId, userId, data);
  if (entityType === 'budget') return writeBudgetLine(companyId, userId, data);
  if (entityType === 'opening_ar_balances') return writeOpeningAr(companyId, userId, data, context.arBalances || new Map());
  if (entityType === 'opening_ap_balances') return writeOpeningAp(companyId, userId, data, context.apBalances || new Map());

  throw new Error(`${entityType} import is not available yet. No records were written.`);
}

async function processValidatedRows({ logId, entityType, companyId, userId, rows, duplicateAction = 'skip', onProgress }) {
  const ImportLog = require('../models/ImportLog');
  const outcomes = [];
  let successRows = 0;
  let errorRows = 0;
  let skippedRows = 0;
  const context = { arBalances: new Map(), apBalances: new Map() };
  await ImportLog.updateOne({ _id: logId, companyId }, { $set: { status: 'processing', startedAt: new Date() } });

  if (entityType === 'opening_gl_balances') {
    try {
      await writeOpeningGl(companyId, userId, rows.filter((row) => row.valid).map((row) => row.data));
      successRows = rows.filter((row) => row.valid).length;
      errorRows = rows.length - successRows;
      outcomes.push(...rows.map((row) => row.valid
        ? { rowNumber: row.rowNumber, status: 'success', message: 'Created opening GL balance.', data: row.data }
        : { rowNumber: row.rowNumber, status: 'error', errors: row.errors, data: row.data }));
    } catch (error) {
      errorRows = rows.length;
      outcomes.push(...rows.map((row) => ({ rowNumber: row.rowNumber, status: 'error', errors: [{ message: error.message }], data: row.data })));
    }
    const reports = await writeReports(logId, outcomes);
    await ImportLog.updateOne({ _id: logId, companyId }, { $set: { status: errorRows > 0 ? 'completed_with_errors' : 'completed', completedAt: new Date(), totalRows: rows.length, successRows, errorRows, skippedRows, rowOutcomes: outcomes, errorReportUrl: reports.errorReportUrl, resultsReportUrl: reports.resultsReportUrl } });
    return { totalRows: rows.length, successRows, errorRows, skippedRows, outcomes, ...reports };
  }

  for (let offset = 0; offset < rows.length; offset += 100) {
    const batch = rows.slice(offset, offset + 100);
    for (const row of batch) {
      if (!row.valid) {
        errorRows += 1;
        outcomes.push({ rowNumber: row.rowNumber, status: 'error', errors: row.errors, data: row.data });
        continue;
      }
      try {
        const action = row.duplicate?.duplicate ? duplicateAction : 'create';
        const outcome = await upsertRow(entityType, companyId, userId, row.data, action, context);
        if (outcome.status === 'success') successRows += 1;
        if (outcome.status === 'skipped') skippedRows += 1;
        outcomes.push({ rowNumber: row.rowNumber, ...outcome, data: row.data });
      } catch (error) {
        errorRows += 1;
        outcomes.push({ rowNumber: row.rowNumber, status: 'error', errors: [{ message: error.message }], data: row.data });
      }
    }
    if (onProgress) await onProgress(Math.min(offset + batch.length, rows.length), rows.length);
  }

  const status = errorRows > 0 ? 'completed_with_errors' : 'completed';
  const reports = await writeReports(logId, outcomes);
  await ImportLog.updateOne({ _id: logId, companyId }, {
    $set: {
      status,
      completedAt: new Date(),
      totalRows: rows.length,
      successRows,
      errorRows,
      skippedRows,
      rowOutcomes: outcomes,
      errorReportUrl: reports.errorReportUrl,
      resultsReportUrl: reports.resultsReportUrl
    }
  });

  return { totalRows: rows.length, successRows, errorRows, skippedRows, outcomes, ...reports };
}

async function writeReports(logId, outcomes) {
  const downloadsDir = path.join(__dirname, '..', 'downloads');
  if (!fs.existsSync(downloadsDir)) fs.mkdirSync(downloadsDir, { recursive: true });
  const rows = outcomes.map((outcome) => ({
    row: outcome.rowNumber,
    status: outcome.status,
    message: outcome.message || (outcome.errors || []).map((error) => error.message).join('; '),
    data: JSON.stringify(outcome.data || {})
  }));
  const resultsFile = `import-results-${logId}-${crypto.randomBytes(4).toString('hex')}.csv`;
  fs.writeFileSync(path.join(downloadsDir, resultsFile), stringify(rows, { header: true }));
  const errorRows = rows.filter((row) => row.status === 'error');
  let errorReportUrl = null;
  if (errorRows.length) {
    const errorFile = `import-errors-${logId}-${crypto.randomBytes(4).toString('hex')}.csv`;
    fs.writeFileSync(path.join(downloadsDir, errorFile), stringify(errorRows, { header: true }));
    errorReportUrl = `/downloads/${errorFile}`;
  }
  return { resultsReportUrl: `/downloads/${resultsFile}`, errorReportUrl };
}

async function generateTemplate(entityType) {
  const definition = getEntityDefinition(entityType);
  if (!definition) throw new Error('Invalid import entity type.');
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Kubika Smart Import';
  const sheet = workbook.addWorksheet(definition.label);
  const instructions = workbook.addWorksheet('Instructions');
  const headers = definition.fields.map((field) => `${field.label}${field.required ? ' *' : ''}`);
  const examples = definition.fields.map((field) => field.example || '');
  const notes = definition.fields.map((field) => field.instructions || '');
  sheet.addRow(headers);
  sheet.addRow(examples);
  sheet.addRow(notes);
  sheet.views = [{ state: 'frozen', ySplit: 1 }];
  sheet.getRow(1).font = { bold: true, color: { argb: 'FF111827' } };
  sheet.getRow(3).font = { italic: true, color: { argb: 'FF6B7280' } };
  sheet.columns = definition.fields.map((field) => ({ width: Math.max(18, field.label.length + 6) }));
  definition.fields.forEach((field, index) => {
    if (field.required) {
      sheet.getRow(1).getCell(index + 1).font = { bold: true, color: { argb: 'FFB91C1C' } };
    }
  });
  instructions.addRows([
    ['Smart Import Template', definition.label],
    ['Step 1', 'Keep row 1 headers unchanged where possible.'],
    ['Step 2', 'Replace row 2 with your data or paste data below it.'],
    ['Step 3', 'Use row 3 instructions to format fields correctly.'],
    ['Limits', 'Maximum 10MB and 10,000 rows per import.']
  ]);
  if (entityType === 'opening_stock') {
    instructions.addRows([
      ['Opening Stock Rules', 'Opening stock can only be imported once per product per warehouse. If you made a mistake — wrong quantity or wrong cost — you cannot re-import. You must ask your accountant to reverse the opening stock journal entry manually through Finance Control → Journal Entries, then import again. Contact your system administrator for assistance.'],
      ['Existing Stock Guard', 'If stock already exists for a product/warehouse (including adjustments or receipts), the import will be blocked. Reverse the prior entry first, then re-import.'],
      ['As-of Date', 'Enter the date your business started or migration date in DD/MM/YYYY. Leave blank to use today (not recommended for historical migrations).']
    ]);
  }
  instructions.columns = [{ width: 24 }, { width: 90 }];
  return workbook.xlsx.writeBuffer();
}

module.exports = {
  MAX_FILE_SIZE,
  MAX_ROWS,
  PROCESSABLE_ENTITY_TYPES,
  getCompanyId,
  parseHeaders,
  validateImport,
  processValidatedRows,
  generateTemplate,
  __test__: {
    normalizeMatch,
    matchScore,
    bestMatch,
    duplicateKeyFor,
    quantityUnitFor,
    isWellFormedRraItemClassCode,
    productPayload,
  }
};
