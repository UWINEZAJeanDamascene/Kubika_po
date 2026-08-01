/**
 * Fast PostgreSQL aggregations for journal lines.
 * Replaces in-memory Mongo-style $unwind pipelines that loaded every entry + line.
 */
const { prisma } = require('../lib/prisma');
const { toIdString } = require('../utils/objectId');
const ChartOfAccounts = require('../models/ChartOfAccount');

const DATE_MARGIN_MS = 24 * 60 * 60 * 1000;

function normalizeCode(code) {
  return String(code).trim();
}

function normalizeCodeKey(code) {
  return normalizeCode(code).replace(/^0+/, '').toLowerCase();
}

function withDateMargin(dateFrom, dateTo) {
  return {
    dateFrom: new Date(dateFrom.getTime() - DATE_MARGIN_MS),
    dateTo: new Date(dateTo.getTime() + DATE_MARGIN_MS),
  };
}

/**
 * Build code -> account type map (respects allow_direct_posting).
 */
async function loadChartTypeMap(companyId) {
  const chartAccounts = await ChartOfAccounts.find({
    company: companyId,
    isActive: true,
  })
    .select('code type allow_direct_posting _id')
    .lean();

  const codeToType = new Map();
  for (const account of chartAccounts || []) {
    if (account.allow_direct_posting === false) continue;
    const code = account.code ? normalizeCode(account.code) : null;
    if (code) {
      codeToType.set(code, account.type);
      codeToType.set(normalizeCodeKey(code), account.type);
    }
    if (account._id) codeToType.set(String(account._id), account.type);
  }
  return codeToType;
}

function resolveAccountType(codeToType, rawCode) {
  if (rawCode == null) return null;
  const code = normalizeCode(rawCode);
  const type =
    codeToType.get(code)
    || codeToType.get(normalizeCodeKey(code))
    || null;
  return type == null ? null : String(type).toLowerCase();
}

/**
 * Sum debit/credit grouped by account_code using SQL.
 */
async function sumLinesByAccountCode(companyId, options = {}) {
  const cid = toIdString(companyId);
  if (!cid) return [];

  const {
    dateFrom = null,
    dateTo = null,
    accountCodes = null,
    excludeSourceType = null,
  } = options;

  const codes = accountCodes
    ? [...new Set(accountCodes.filter(Boolean).map(String))]
    : null;

  if (codes && codes.length === 0) return [];

  if (codes) {
    if (dateFrom && dateTo) {
      if (excludeSourceType) {
        return prisma.$queryRaw`
          SELECT jel.account_code AS "accountCode",
                 COALESCE(SUM(jel.debit), 0)::float AS "totalDebit",
                 COALESCE(SUM(jel.credit), 0)::float AS "totalCredit"
          FROM journal_entry_lines jel
          INNER JOIN journal_entries je ON je.id = jel.journal_entry_id
          WHERE je.company_id = ${cid}
            AND je.status = 'posted'
            AND je.reversed = false
            AND je.date >= ${dateFrom}
            AND je.date <= ${dateTo}
            AND (je.source_type IS NULL OR je.source_type <> ${excludeSourceType})
            AND jel.account_code = ANY(${codes}::text[])
          GROUP BY jel.account_code
        `;
      }
      return prisma.$queryRaw`
        SELECT jel.account_code AS "accountCode",
               COALESCE(SUM(jel.debit), 0)::float AS "totalDebit",
               COALESCE(SUM(jel.credit), 0)::float AS "totalCredit"
        FROM journal_entry_lines jel
        INNER JOIN journal_entries je ON je.id = jel.journal_entry_id
        WHERE je.company_id = ${cid}
          AND je.status = 'posted'
          AND je.reversed = false
          AND je.date >= ${dateFrom}
          AND je.date <= ${dateTo}
          AND jel.account_code = ANY(${codes}::text[])
        GROUP BY jel.account_code
      `;
    }

    // "Balance as of a date" (e.g. financial ratios / balance sheet): no lower
    // bound, so this sums every posted line up to dateTo.
    if (dateTo && !dateFrom) {
      return prisma.$queryRaw`
        SELECT jel.account_code AS "accountCode",
               COALESCE(SUM(jel.debit), 0)::float AS "totalDebit",
               COALESCE(SUM(jel.credit), 0)::float AS "totalCredit"
        FROM journal_entry_lines jel
        INNER JOIN journal_entries je ON je.id = jel.journal_entry_id
        WHERE je.company_id = ${cid}
          AND je.status = 'posted'
          AND je.reversed = false
          AND je.date <= ${dateTo}
          AND jel.account_code = ANY(${codes}::text[])
        GROUP BY jel.account_code
      `;
    }

    if (excludeSourceType) {
      return prisma.$queryRaw`
        SELECT jel.account_code AS "accountCode",
               COALESCE(SUM(jel.debit), 0)::float AS "totalDebit",
               COALESCE(SUM(jel.credit), 0)::float AS "totalCredit"
        FROM journal_entry_lines jel
        INNER JOIN journal_entries je ON je.id = jel.journal_entry_id
        WHERE je.company_id = ${cid}
          AND je.status = 'posted'
          AND je.reversed = false
          AND (je.source_type IS NULL OR je.source_type <> ${excludeSourceType})
          AND jel.account_code = ANY(${codes}::text[])
        GROUP BY jel.account_code
      `;
    }

    return prisma.$queryRaw`
      SELECT jel.account_code AS "accountCode",
             COALESCE(SUM(jel.debit), 0)::float AS "totalDebit",
             COALESCE(SUM(jel.credit), 0)::float AS "totalCredit"
      FROM journal_entry_lines jel
      INNER JOIN journal_entries je ON je.id = jel.journal_entry_id
      WHERE je.company_id = ${cid}
        AND je.status = 'posted'
        AND je.reversed = false
        AND jel.account_code = ANY(${codes}::text[])
      GROUP BY jel.account_code
    `;
  }

  if (dateFrom && dateTo) {
    return prisma.$queryRaw`
      SELECT jel.account_code AS "accountCode",
             COALESCE(SUM(jel.debit), 0)::float AS "totalDebit",
             COALESCE(SUM(jel.credit), 0)::float AS "totalCredit"
      FROM journal_entry_lines jel
      INNER JOIN journal_entries je ON je.id = jel.journal_entry_id
      WHERE je.company_id = ${cid}
        AND je.status = 'posted'
        AND je.reversed = false
        AND je.date >= ${dateFrom}
        AND je.date <= ${dateTo}
      GROUP BY jel.account_code
    `;
  }

  // "Balance as of a date", all account codes (e.g. full balance sheet).
  if (dateTo && !dateFrom) {
    return prisma.$queryRaw`
      SELECT jel.account_code AS "accountCode",
             COALESCE(SUM(jel.debit), 0)::float AS "totalDebit",
             COALESCE(SUM(jel.credit), 0)::float AS "totalCredit"
      FROM journal_entry_lines jel
      INNER JOIN journal_entries je ON je.id = jel.journal_entry_id
      WHERE je.company_id = ${cid}
        AND je.status = 'posted'
        AND je.reversed = false
        AND je.date <= ${dateTo}
      GROUP BY jel.account_code
    `;
  }

  return prisma.$queryRaw`
    SELECT jel.account_code AS "accountCode",
           COALESCE(SUM(jel.debit), 0)::float AS "totalDebit",
           COALESCE(SUM(jel.credit), 0)::float AS "totalCredit"
    FROM journal_entry_lines jel
    INNER JOIN journal_entries je ON je.id = jel.journal_entry_id
    WHERE je.company_id = ${cid}
      AND je.status = 'posted'
      AND je.reversed = false
    GROUP BY jel.account_code
  `;
}

/**
 * Sum cash lines grouped by source_type (for cash-flow widgets).
 */
async function sumCashLinesBySourceType(companyId, accountCodes, dateFrom, dateTo) {
  const cid = toIdString(companyId);
  const codes = [...new Set(accountCodes.filter(Boolean).map(String))];
  if (!cid || codes.length === 0) return [];

  return prisma.$queryRaw`
    SELECT je.source_type AS "sourceType",
           COALESCE(SUM(jel.debit), 0)::float AS "totalDebit",
           COALESCE(SUM(jel.credit), 0)::float AS "totalCredit"
    FROM journal_entry_lines jel
    INNER JOIN journal_entries je ON je.id = jel.journal_entry_id
    WHERE je.company_id = ${cid}
      AND je.status = 'posted'
      AND je.reversed = false
      AND je.date >= ${dateFrom}
      AND je.date <= ${dateTo}
      AND jel.account_code = ANY(${codes}::text[])
    GROUP BY je.source_type
  `;
}

function totalForAccountType(rows, codeToType, accountType) {
  const wanted = String(accountType || '').toLowerCase();
  let totalDr = 0;
  let totalCr = 0;
  for (const row of rows) {
    const type = resolveAccountType(codeToType, row.accountCode);
    if (type !== wanted) continue;
    totalDr += Number(row.totalDebit) || 0;
    totalCr += Number(row.totalCredit) || 0;
  }
  if (wanted === 'revenue') return totalCr - totalDr;
  return totalDr - totalCr;
}

/** Sum one or more account types (e.g. expense + cogs). */
function totalForAccountTypes(rows, codeToType, accountTypes) {
  const types = Array.isArray(accountTypes) ? accountTypes : [accountTypes];
  return types.reduce(
    (sum, type) => sum + totalForAccountType(rows, codeToType, type),
    0,
  );
}

function balancesMapFromRows(rows) {
  const map = {};
  for (const row of rows) {
    map[row.accountCode] = (Number(row.totalDebit) || 0) - (Number(row.totalCredit) || 0);
  }
  return map;
}

/**
 * Product IDs with outbound activity since a date (for dead-stock detection).
 */
async function getActiveOutboundProductIds(companyId, sinceDate) {
  const cid = toIdString(companyId);
  if (!cid) return [];

  const rows = await prisma.$queryRaw`
    SELECT DISTINCT sm.product_id AS "productId"
    FROM stock_movements sm
    WHERE sm.company_id = ${cid}
      AND sm.movement_date >= ${sinceDate}
      AND sm.product_id IS NOT NULL
      AND (
        sm.reason IN ('dispatch', 'transfer_out')
        OR sm.type = 'out'
      )
  `;

  return rows.map((r) => String(r.productId)).filter(Boolean);
}

module.exports = {
  DATE_MARGIN_MS,
  withDateMargin,
  loadChartTypeMap,
  resolveAccountType,
  sumLinesByAccountCode,
  sumCashLinesBySourceType,
  totalForAccountType,
  totalForAccountTypes,
  balancesMapFromRows,
  getActiveOutboundProductIds,
};
