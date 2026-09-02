/**
 * Build AR/AP ledger views from PostgreSQL source documents.
 *
 * The legacy implementation loaded every invoice, credit note, receipt, GRN,
 * purchase, and payment into Node before sorting and slicing. These views are
 * now composed in PostgreSQL with UNION ALL, indexed tenant/date predicates,
 * and database-level LIMIT/OFFSET pagination.
 */

const { dbClient } = require('../lib/prisma');

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

function money(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function pagination(page, limit) {
  const safePage = Math.max(1, Number.parseInt(page, 10) || 1);
  const safeLimit = Math.min(MAX_LIMIT, Math.max(1, Number.parseInt(limit, 10) || DEFAULT_LIMIT));
  return { page: safePage, limit: safeLimit, offset: (safePage - 1) * safeLimit };
}

function dateValue(value) {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function buildArQuery(companyId, filters = {}) {
  const { clientId, invoiceId, transactionType, startDate, endDate, reconciliationStatus } = filters;
  const params = [String(companyId)];
  const addParam = (value) => {
    params.push(value);
    return `$${params.length}`;
  };
  const start = dateValue(startDate);
  const end = dateValue(endDate);
  const startParam = start ? addParam(start) : null;
  const endParam = end ? addParam(end) : null;
  const reconciliationParam = addParam(reconciliationStatus || null);
  const clientParam = clientId ? addParam(String(clientId)) : null;
  const invoiceParam = invoiceId ? addParam(String(invoiceId)) : null;
  const dateWhere = (expression) => [
    startParam ? `${expression} >= ${startParam}` : null,
    endParam ? `${expression} <= ${endParam}` : null,
  ].filter(Boolean);

  const sources = [];
  if (!transactionType || transactionType === 'invoice_created') {
    sources.push(`
      SELECT
        'ar-inv-' || i.id AS id,
        i.invoice_date AS transaction_date,
        json_build_object('_id', c.id, 'name', c.name, 'code', c.code) AS client,
        json_build_object('_id', i.id, 'referenceNo', i.reference_no) AS invoice,
        'invoice_created'::text AS transaction_type,
        i.reference_no AS reference_no,
        ('Invoice ' || i.reference_no || ' created') AS description,
        i.total_amount::double precision AS amount,
        'increase'::text AS direction,
        COALESCE(${reconciliationParam}::text, 'pending') AS reconciliation_status
      FROM invoices i
      JOIN clients c ON c.id = i.client_id
      WHERE i.company_id = $1
        AND i.status IN ('confirmed', 'partially_paid', 'fully_paid')
        ${clientParam ? `AND i.client_id = ${clientParam}` : ''}
        ${invoiceParam ? `AND i.id = ${invoiceParam}` : ''}
        ${dateWhere('i.invoice_date').map((clause) => `AND ${clause}`).join(' ')}`);
  }

  if (!transactionType || transactionType === 'credit_note_applied') {
    sources.push(`
      SELECT
        'ar-cn-' || cn.id AS id,
        cn.credit_date AS transaction_date,
        json_build_object('_id', c.id, 'name', c.name, 'code', c.code) AS client,
        json_build_object('_id', i.id, 'referenceNo', i.reference_no) AS invoice,
        'credit_note_applied'::text AS transaction_type,
        cn.reference_no AS reference_no,
        ('Credit note ' || cn.reference_no) AS description,
        cn.total_amount::double precision AS amount,
        'decrease'::text AS direction,
        COALESCE(${reconciliationParam}::text, 'pending') AS reconciliation_status
      FROM credit_notes cn
      JOIN clients c ON c.id = cn.client_id
      JOIN invoices i ON i.id = cn.invoice_id
      WHERE cn.company_id = $1
        AND cn.status IN ('confirmed', 'issued', 'applied')
        ${clientParam ? `AND cn.client_id = ${clientParam}` : ''}
        ${invoiceParam ? `AND cn.invoice_id = ${invoiceParam}` : ''}
        ${dateWhere('cn.credit_date').map((clause) => `AND ${clause}`).join(' ')}`);
  }

  if (!transactionType || transactionType === 'receipt_posted' || transactionType === 'payment_recorded') {
    sources.push(`
      SELECT
        'ar-rc-' || r.id AS id,
        r.receipt_date AS transaction_date,
        json_build_object('_id', c.id, 'name', c.name, 'code', c.code) AS client,
        NULL::json AS invoice,
        'receipt_posted'::text AS transaction_type,
        r.reference_no AS reference_no,
        ('Receipt ' || r.reference_no) AS description,
        r.amount_received::double precision AS amount,
        'decrease'::text AS direction,
        COALESCE(${reconciliationParam}::text, 'pending') AS reconciliation_status
      FROM ar_receipts r
      JOIN clients c ON c.id = r.client_id
      WHERE r.company_id = $1
        AND r.status IN ('posted', 'confirmed')
        ${clientParam ? `AND r.client_id = ${clientParam}` : ''}
        ${dateWhere('r.receipt_date').map((clause) => `AND ${clause}`).join(' ')}`);
  }

  return { sql: sources.length ? sources.join('\nUNION ALL\n') : 'SELECT NULL::text AS id WHERE FALSE', params };
}

function buildApQuery(companyId, filters = {}) {
  const { supplierId, transactionType, startDate, endDate, reconciliationStatus } = filters;
  const params = [String(companyId)];
  const addParam = (value) => {
    params.push(value);
    return `$${params.length}`;
  };
  const start = dateValue(startDate);
  const end = dateValue(endDate);
  const startParam = start ? addParam(start) : null;
  const endParam = end ? addParam(end) : null;
  const reconciliationParam = addParam(reconciliationStatus || null);
  const supplierParam = supplierId ? addParam(String(supplierId)) : null;
  const dateWhere = (expression) => [
    startParam ? `${expression} >= ${startParam}` : null,
    endParam ? `${expression} <= ${endParam}` : null,
  ].filter(Boolean);

  const sources = [];
  if (!transactionType || transactionType === 'grn_received') {
    sources.push(`
      SELECT
        'ap-grn-' || g.id AS id,
        g.received_date AS transaction_date,
        json_build_object('_id', s.id, 'name', s.name, 'code', s.code) AS supplier,
        json_build_object('_id', g.id, 'referenceNo', g.reference_no) AS grn,
        NULL::json AS payment,
        'grn_received'::text AS transaction_type,
        g.reference_no AS reference_no,
        ('GRN ' || g.reference_no || ' received') AS description,
        g.total_amount::double precision AS amount,
        'increase'::text AS direction,
        COALESCE(${reconciliationParam}::text, 'pending') AS reconciliation_status
      FROM goods_received_notes g
      JOIN suppliers s ON s.id = g.supplier_id
      WHERE g.company_id = $1
        AND g.status IN ('confirmed', 'posted', 'partially_paid', 'fully_paid')
        ${supplierParam ? `AND g.supplier_id = ${supplierParam}` : ''}
        ${dateWhere('g.received_date').map((clause) => `AND ${clause}`).join(' ')}`);

    sources.push(`
      SELECT
        'ap-pur-' || p.id AS id,
        p.purchase_date AS transaction_date,
        json_build_object('_id', s.id, 'name', s.name, 'code', s.code) AS supplier,
        NULL::json AS grn,
        NULL::json AS payment,
        'grn_received'::text AS transaction_type,
        p.purchase_number AS reference_no,
        ('Purchase ' || p.purchase_number) AS description,
        p.total_amount::double precision AS amount,
        'increase'::text AS direction,
        COALESCE(${reconciliationParam}::text, 'pending') AS reconciliation_status
      FROM purchases p
      JOIN suppliers s ON s.id = p.supplier_id
      WHERE p.company_id = $1
        AND p.status IN ('confirmed', 'posted', 'partially_paid', 'fully_paid')
        ${supplierParam ? `AND p.supplier_id = ${supplierParam}` : ''}
        ${dateWhere('p.purchase_date').map((clause) => `AND ${clause}`).join(' ')}`);
  }

  if (!transactionType || transactionType === 'payment_posted') {
    sources.push(`
      SELECT
        'ap-pay-' || p.id AS id,
        p.payment_date AS transaction_date,
        json_build_object('_id', s.id, 'name', s.name, 'code', s.code) AS supplier,
        NULL::json AS grn,
        json_build_object('_id', p.id, 'referenceNo', p.reference_no) AS payment,
        'payment_posted'::text AS transaction_type,
        p.reference_no AS reference_no,
        ('Payment ' || p.reference_no) AS description,
        p.amount_paid::double precision AS amount,
        'decrease'::text AS direction,
        COALESCE(${reconciliationParam}::text, 'pending') AS reconciliation_status
      FROM ap_payments p
      JOIN suppliers s ON s.id = p.supplier_id
      WHERE p.company_id = $1
        AND p.status IN ('posted', 'confirmed')
        ${supplierParam ? `AND p.supplier_id = ${supplierParam}` : ''}
        ${dateWhere('p.payment_date').map((clause) => `AND ${clause}`).join(' ')}`);
  }

  return { sql: sources.length ? sources.join('\nUNION ALL\n') : 'SELECT NULL::text AS id WHERE FALSE', params };
}

async function readPagedQuery(buildQuery, companyId, filters, page, limit) {
  const { page: requestedPage, limit: pageSize, offset } = pagination(page, limit);
  const base = buildQuery(companyId, filters);
  const countParams = [...base.params];
  const countRows = await dbClient().$queryRawUnsafe(
    `WITH ledger_rows AS (${base.sql}) SELECT COUNT(*)::int AS total FROM ledger_rows`,
    ...countParams,
  );
  const total = Number(countRows[0]?.total || 0);
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const currentPage = Math.min(requestedPage, pages);
  const actualOffset = (currentPage - 1) * pageSize;
  const dataParams = [...base.params, pageSize, actualOffset];
  const rows = await dbClient().$queryRawUnsafe(
    `WITH ledger_rows AS (${base.sql})
     SELECT * FROM ledger_rows
     ORDER BY transaction_date DESC NULLS LAST, id DESC
     LIMIT $${dataParams.length - 1} OFFSET $${dataParams.length}`,
    ...dataParams,
  );

  return {
    items: rows.map((row) => ({
      _id: row.id,
      transactionDate: row.transaction_date,
      client: row.client || undefined,
      supplier: row.supplier || undefined,
      invoice: row.invoice || undefined,
      grn: row.grn || undefined,
      payment: row.payment || undefined,
      transactionType: row.transaction_type,
      referenceNo: row.reference_no,
      description: row.description,
      amount: money(row.amount),
      direction: row.direction,
      reconciliationStatus: row.reconciliation_status,
    })),
    total,
    pages,
    currentPage,
  };
}

async function getARTransactions(companyId, filters = {}, options = {}) {
  return readPagedQuery(buildArQuery, companyId, filters, options.page, options.limit);
}

async function getAPTransactions(companyId, filters = {}, options = {}) {
  return readPagedQuery(buildApQuery, companyId, filters, options.page, options.limit);
}

module.exports = {
  getARTransactions,
  getAPTransactions,
};
