'use strict';

const { dbClient } = require('../lib/prisma');
const { generateObjectId } = require('../utils/objectId');

const companyIdFor = (req) => String(req.user?.company?._id || req.user?.companyId || '');
const validId = (value) => /^[0-9a-f]{24}$/i.test(String(value || ''));
const presentPriceList = (row) => ({
  _id: String(row.id),
  name: row.name,
  description: row.description || '',
  isActive: row.isActive ?? row.is_active ?? true,
  createdAt: row.createdAt ?? row.created_at,
  updatedAt: row.updatedAt ?? row.updated_at,
});

function normalizePriceItems(items) {
  if (!Array.isArray(items) || items.length > 5000) return null;
  const seen = new Set();
  const normalized = [];
  for (const item of items) {
    const productId = String(item?.productId || '');
    const price = Number(item?.price);
    if (!validId(productId) || seen.has(productId) || !Number.isFinite(price) || price < 0
      || price > 999999999999999 || Math.abs(price * 10000 - Math.round(price * 10000)) > 0.00001) {
      return null;
    }
    seen.add(productId);
    normalized.push({ productId, price: price.toFixed(4) });
  }
  return normalized;
}

async function replacePrices(tx, companyId, priceListId, items) {
  if (items.length) {
    const products = await tx.$queryRawUnsafe(
      'SELECT id FROM products WHERE company_id = $1 AND id = ANY($2::char(24)[])',
      companyId,
      items.map((item) => item.productId),
    );
    if (products.length !== items.length) {
      const error = new Error('One or more selected products are unavailable in this workspace.');
      error.status = 400;
      error.code = 'PRICE_LIST_PRODUCT_INVALID';
      throw error;
    }
  }
  await tx.$executeRawUnsafe(
    'DELETE FROM price_list_items WHERE company_id = $1 AND price_list_id = $2',
    companyId,
    priceListId,
  );
  if (!items.length) return;
  const values = [];
  const parameters = [];
  items.forEach((item, index) => {
    const offset = index * 5;
    values.push(`($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}::numeric, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`);
    parameters.push(generateObjectId(), companyId, priceListId, item.productId, item.price);
  });
  await tx.$executeRawUnsafe(
    `INSERT INTO price_list_items (id, company_id, price_list_id, product_id, price, created_at, updated_at)
     SELECT v.id, v.company_id, v.price_list_id, v.product_id, v.price, v.created_at, v.updated_at
       FROM (VALUES ${values.join(',')}) AS v(id, company_id, price_list_id, product_id, price, created_at, updated_at)`,
    ...parameters,
  );
}

exports.listManage = async (req, res, next) => {
  try {
    const companyId = companyIdFor(req);
    const [lists, warehouses, products, prices] = await Promise.all([
      dbClient().$queryRawUnsafe(
        'SELECT id, name, description, is_active AS "isActive", created_at AS "createdAt", updated_at AS "updatedAt" FROM price_lists WHERE company_id = $1 ORDER BY name ASC LIMIT 501',
        companyId,
      ),
      dbClient().$queryRawUnsafe(
        'SELECT id, name, code, price_list_id AS "priceListId" FROM warehouses WHERE company_id = $1 AND is_active = TRUE ORDER BY name ASC LIMIT 1001',
        companyId,
      ),
      dbClient().$queryRawUnsafe(
        'SELECT id, name, sku, selling_price AS "sellingPrice", unit FROM products WHERE company_id = $1 AND is_active = TRUE AND is_archived = FALSE ORDER BY name ASC LIMIT 5001',
        companyId,
      ),
      dbClient().$queryRawUnsafe(
        'SELECT price_list_id AS "priceListId", product_id AS "productId", price FROM price_list_items WHERE company_id = $1 ORDER BY price_list_id, product_id LIMIT 25001',
        companyId,
      ),
    ]);
    if (lists.length > 500 || warehouses.length > 1000 || products.length > 5000 || prices.length > 25000) {
      return res.status(413).json({
        success: false,
        code: 'PRICE_LIST_CATALOG_TOO_LARGE',
        message: 'This workspace exceeds the safe price-list management limits. Narrow the active catalog or contact support.',
      });
    }
    return res.json({
      success: true,
      data: {
        priceLists: lists.map(presentPriceList),
        warehouses: warehouses.map((row) => ({
          _id: String(row.id),
          name: row.name,
          code: row.code,
          priceListId: row.priceListId ? String(row.priceListId) : null,
        })),
        products: products.map((row) => ({
          _id: String(row.id),
          name: row.name,
          sku: row.sku,
          unit: row.unit,
          sellingPrice: Number(row.sellingPrice),
        })),
        prices: prices.map((row) => ({
          priceListId: String(row.priceListId),
          productId: String(row.productId),
          price: Number(row.price),
        })),
      },
    });
  } catch (error) { return next(error); }
};

exports.create = async (req, res, next) => {
  try {
    const companyId = companyIdFor(req);
    const name = String(req.body?.name || '').trim();
    const description = String(req.body?.description || '').trim();
    if (name.length < 2 || name.length > 120 || description.length > 1000) {
      return res.status(400).json({ success: false, code: 'PRICE_LIST_INVALID', message: 'Enter a price list name between 2 and 120 characters and a description under 1000 characters.' });
    }
    const rows = await dbClient().$queryRawUnsafe(
      `INSERT INTO price_lists (id, company_id, name, description, is_active, created_by_id, created_at, updated_at)
       VALUES ($1, $2, $3, $4, TRUE, $5, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
       RETURNING id, name, description, is_active AS "isActive", created_at AS "createdAt", updated_at AS "updatedAt"`,
      generateObjectId(), companyId, name, description, String(req.user.id),
    );
    return res.status(201).json({ success: true, data: presentPriceList(rows[0]) });
  } catch (error) {
    if (error?.code === 'P2002' || error?.code === '23505' || error?.meta?.code === '23505') {
      return res.status(409).json({ success: false, code: 'PRICE_LIST_NAME_EXISTS', message: 'A price list with that name already exists in this workspace.' });
    }
    return next(error);
  }
};

exports.update = async (req, res, next) => {
  try {
    const companyId = companyIdFor(req);
    const priceListId = String(req.params.priceListId || '');
    const name = String(req.body?.name || '').trim();
    const description = String(req.body?.description || '').trim();
    if (!validId(priceListId) || name.length < 2 || name.length > 120 || description.length > 1000) {
      return res.status(400).json({ success: false, code: 'PRICE_LIST_INVALID', message: 'Enter a valid price list name and description.' });
    }
    const rows = await dbClient().$queryRawUnsafe(
      'UPDATE price_lists SET name = $1, description = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3 AND company_id = $4 RETURNING id, name, description, is_active AS "isActive", created_at AS "createdAt", updated_at AS "updatedAt"',
      name, description, priceListId, companyId,
    );
    if (!rows.length) return res.status(404).json({ success: false, code: 'PRICE_LIST_NOT_FOUND', message: 'Price list was not found.' });
    return res.json({ success: true, data: presentPriceList(rows[0]) });
  } catch (error) {
    if (error?.code === 'P2002' || error?.code === '23505' || error?.meta?.code === '23505') {
      return res.status(409).json({ success: false, code: 'PRICE_LIST_NAME_EXISTS', message: 'A price list with that name already exists in this workspace.' });
    }
    return next(error);
  }
};

exports.replacePrices = async (req, res, next) => {
  try {
    const companyId = companyIdFor(req);
    const priceListId = String(req.params.priceListId || '');
    const items = normalizePriceItems(req.body?.items);
    if (!validId(priceListId) || !items) {
      return res.status(400).json({ success: false, code: 'PRICE_LIST_PRICES_INVALID', message: 'Prices must contain unique valid product IDs and non-negative amounts with at most four decimal places.' });
    }
    const database = dbClient();
    await database.$transaction(async (tx) => {
      const lists = await tx.$queryRawUnsafe(
        'SELECT id FROM price_lists WHERE id = $1 AND company_id = $2 AND is_active = TRUE FOR UPDATE',
        priceListId, companyId,
      );
      if (!lists.length) {
        const error = new Error('Price list was not found or is inactive.');
        error.status = 404;
        error.code = 'PRICE_LIST_NOT_FOUND';
        throw error;
      }
      await replacePrices(tx, companyId, priceListId, items);
      await tx.$executeRawUnsafe(
        'UPDATE price_lists SET updated_at = CURRENT_TIMESTAMP WHERE id = $1 AND company_id = $2',
        priceListId, companyId,
      );
    });
    return res.json({ success: true, message: 'Price list prices saved.', count: items.length });
  } catch (error) {
    if (error?.code === 'PRICE_LIST_NOT_FOUND' || error?.code === 'PRICE_LIST_PRODUCT_INVALID') {
      return res.status(error.status).json({ success: false, code: error.code, message: error.message });
    }
    return next(error);
  }
};

exports.assignWarehouse = async (req, res, next) => {
  try {
    const companyId = companyIdFor(req);
    const warehouseId = String(req.params.warehouseId || '');
    const priceListId = req.body?.priceListId == null || req.body.priceListId === ''
      ? null
      : String(req.body.priceListId);
    if (!validId(warehouseId) || (priceListId && !validId(priceListId))) {
      return res.status(400).json({ success: false, code: 'PRICE_LIST_ASSIGNMENT_INVALID', message: 'Select a valid warehouse and price list.' });
    }
    if (priceListId) {
      const lists = await dbClient().$queryRawUnsafe(
        'SELECT id FROM price_lists WHERE id = $1 AND company_id = $2 AND is_active = TRUE LIMIT 1',
        priceListId, companyId,
      );
      if (!lists.length) return res.status(404).json({ success: false, code: 'PRICE_LIST_NOT_FOUND', message: 'An active price list was not found in this workspace.' });
    }
    const rows = await dbClient().$queryRawUnsafe(
      'UPDATE warehouses SET price_list_id = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2 AND company_id = $3 RETURNING id, price_list_id AS "priceListId"',
      priceListId, warehouseId, companyId,
    );
    if (!rows.length) return res.status(404).json({ success: false, code: 'WAREHOUSE_NOT_FOUND', message: 'Warehouse was not found in this workspace.' });
    return res.json({ success: true, data: { warehouseId: String(rows[0].id), priceListId: rows[0].priceListId ? String(rows[0].priceListId) : null } });
  } catch (error) { return next(error); }
};
