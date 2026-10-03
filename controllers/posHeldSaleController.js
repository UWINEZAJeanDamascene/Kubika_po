const { prisma } = require('../lib/prisma');
const { generateObjectId, toIdString } = require('../utils/objectId');

function getScope(req) {
  const companyId = toIdString(req.company?._id || req.company?.id || req.user?.company?._id || req.user?.company);
  const userId = toIdString(req.user?._id || req.user?.id);
  if (!companyId || !userId) {
    const error = new Error('A company and signed-in user are required.');
    error.statusCode = 401;
    throw error;
  }
  return { companyId, userId };
}

function publicHeldSale(row) {
  return {
    id: row.id,
    heldAt: row.createdAt,
    label: row.label,
    ...row.saleData,
  };
}

exports.listHeldSales = async (req, res, next) => {
  try {
    const { companyId } = getScope(req);
    const rows = await prisma.$queryRawUnsafe(
      'SELECT id, label, sale_data AS "saleData", created_at AS "createdAt" FROM pos_held_sales WHERE company_id = $1 ORDER BY created_at DESC LIMIT 100',
      companyId,
    );
    return res.json({ success: true, data: rows.map(publicHeldSale) });
  } catch (error) {
    return next(error);
  }
};

exports.createHeldSale = async (req, res, next) => {
  try {
    const { companyId, userId } = getScope(req);
    const { label, saleData } = req.body || {};
    if (!saleData || typeof saleData !== 'object' || Array.isArray(saleData)
      || !Array.isArray(saleData.cart) || saleData.cart.length === 0 || saleData.cart.length > 100) {
      return res.status(400).json({ success: false, message: 'A held sale must contain between 1 and 100 cart lines.' });
    }
    if (Buffer.byteLength(JSON.stringify(saleData), 'utf8') > 500_000) {
      return res.status(413).json({ success: false, message: 'Held sale is too large to save.' });
    }
    const countRows = await prisma.$queryRawUnsafe(
      'SELECT COUNT(*)::int AS count FROM pos_held_sales WHERE company_id = $1',
      companyId,
    );
    const heldCount = Number(countRows[0]?.count || 0);
    if (heldCount >= 100) {
      return res.status(409).json({ success: false, message: 'This workspace already has 100 held sales. Recall or remove one before holding another.' });
    }

    const rows = await prisma.$queryRawUnsafe(
      'INSERT INTO pos_held_sales (id, company_id, created_by_id, label, sale_data, created_at, updated_at) VALUES ($1, $2, $3, $4, $5::jsonb, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP) RETURNING id, label, sale_data AS "saleData", created_at AS "createdAt"',
      generateObjectId(),
      companyId,
      userId,
      String(label || 'Held sale').trim().slice(0, 120) || 'Held sale',
      JSON.stringify(saleData),
    );
    const row = rows[0];
    return res.status(201).json({ success: true, data: publicHeldSale(row) });
  } catch (error) {
    return next(error);
  }
};

exports.deleteHeldSale = async (req, res, next) => {
  try {
    const { companyId } = getScope(req);
    const rows = await prisma.$queryRawUnsafe(
      'DELETE FROM pos_held_sales WHERE id = $1 AND company_id = $2 RETURNING id',
      String(req.params.heldSaleId || ''),
      companyId,
    );
    if (!rows.length) return res.status(404).json({ success: false, message: 'Held sale not found.' });
    return res.json({ success: true, message: 'Held sale removed.' });
  } catch (error) {
    return next(error);
  }
};
