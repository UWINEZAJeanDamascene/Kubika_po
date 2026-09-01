/**
 * Fast PostgreSQL aggregations for journal lines.
 * Replaces in-memory Mongo-style $unwind pipelines that loaded every entry + line.
 */
const { Prisma } = require('@prisma/client');
const { prisma, dbClient } = require('../lib/prisma');
const { toIdString } = require('../utils/objectId');
const ChartOfAccounts = require('../models/ChartOfAccount');

const DATE_MARGIN_MS = 24 * 60 * 60 * 1000;

/** Values of the JournalEntryStatus enum, for safe literal interpolation. */
const JOURNAL_STATUSES = new Set(['draft', 'posted', 'voided', 'reversed']);

/**
 * Group keys the pipelines used, mapped to their column. Only keys in this
 * table can reach the SQL, so the identifier is never caller-controlled.
 */
const GROUP_BY_COLUMNS = {
  accountCode: 'jel.account_code',
  accountName: 'jel.account_name',
  accountId: 'jel.account_id',
  sourceType: 'je.source_type',
};

/**
 * SQL replacement for the `$unwind: '$lines'` + `$group` pipelines that the
 * report services ran through utils/prismaAggregate.js.
 *
 * The shim could only push the leading `$match` to Postgres: it loaded every
 * matching journal entry *with all its lines included* into the Node heap and
 * grouped them there. For a tenant with a year of postings that is the whole
 * general ledger, per report, per request. This does the same work in one
 * GROUP BY, supported by the existing (company_id, status, date) and
 * (company_id, account_code) indexes.
 *
 * Every filter is optional and defaults to OFF, because the JS pipelines it
 * replaces did not apply them. In particular `excludeReversed` defaults to
 * false: sumLinesByAccountCode() hard-codes `reversed = false`, but the
 * pipelines here did not, and silently adopting that filter would change
 * published financial statements. Each call site passes what it actually had.
 *
 * @param {string} companyId
 * @param {object} [options]
 * @param {Date}   [options.dateFrom]        lower bound on je.date
 * @param {Date}   [options.dateTo]          upper bound on je.date
 * @param {boolean}[options.dateFromInclusive=true]  true = `>=`, false = `>`
 * @param {boolean}[options.dateToInclusive=true]    true = `<=`, false = `<`
 * @param {string} [options.status]          exact je.status, omit for no filter
 * @param {boolean}[options.excludeReversed=false]   add `reversed = false`
 * @param {string} [options.excludeSourceType]       omit rows with this source_type
 * @param {string[]}[options.accountCodes]   exact account codes (IN)
 * @param {string[]}[options.accountCodePrefixes]    code prefixes (LIKE 'x%')
 * @param {boolean}[options.groupByAccountCode=true] false = one grand total
 * @param {boolean}[options.withCount=false] include a line count
 * Rows carry the group key as both `accountCode` and `_id`. The `_id` alias is
 * not decoration: it lets each converted call site swap the pipeline for this
 * call without touching the code that consumes the result, which is what keeps
 * a mechanical change from quietly becoming a financial one.
 *
 * @returns {Promise<Array<{accountCode: string|null, _id: string|null, debit: number, credit: number, count?: number}>>}
 */
async function sumJournalLines(companyId, options = {}) {
  const cid = toIdString(companyId);
  if (!cid) return [];

  const {
    dateFrom = null,
    dateTo = null,
    dateFromInclusive = true,
    dateToInclusive = true,
    status = null,
    excludeReversed = false,
    excludeSourceType = null,
    excludeSourceTypes = null,
    accountCodes = null,
    accountCodePrefixes = null,
    accountIds = null,
    minDebit = null,
    groupByAccountCode = true,
    groupBy = null,
    withCount = false,
  } = options;

  // `groupBy` supersedes the boolean; the boolean is kept because most call
  // sites only ever group by account code.
  const groupKey = groupBy !== null ? groupBy : (groupByAccountCode ? 'accountCode' : null);
  if (groupKey !== null && !GROUP_BY_COLUMNS[groupKey]) {
    throw new Error(`sumJournalLines: cannot group by "${groupKey}"`);
  }

  const conditions = [Prisma.sql`je.company_id = ${cid}`];

  if (status) {
    // Whitelisted against the enum, so this literal cannot carry user input.
    if (!JOURNAL_STATUSES.has(status)) {
      throw new Error(`sumJournalLines: unknown journal status "${status}"`);
    }
    conditions.push(Prisma.sql`je.status = ${Prisma.raw(`'${status}'`)}`);
  }
  if (excludeReversed) conditions.push(Prisma.sql`je.reversed = false`);
  if (excludeSourceType) {
    conditions.push(
      Prisma.sql`(je.source_type IS NULL OR je.source_type <> ${excludeSourceType})`,
    );
  }
  if (dateFrom) {
    conditions.push(
      dateFromInclusive ? Prisma.sql`je.date >= ${dateFrom}` : Prisma.sql`je.date > ${dateFrom}`,
    );
  }
  if (dateTo) {
    conditions.push(
      dateToInclusive ? Prisma.sql`je.date <= ${dateTo}` : Prisma.sql`je.date < ${dateTo}`,
    );
  }

  if (accountCodes) {
    const codes = [...new Set(accountCodes.filter(Boolean).map(String))];
    // An empty code list means "match nothing" — not "match everything".
    if (codes.length === 0) return [];
    conditions.push(Prisma.sql`jel.account_code = ANY(${codes}::text[])`);
  }
  if (accountCodePrefixes) {
    const patterns = [...new Set(accountCodePrefixes.filter(Boolean).map((p) => `${p}%`))];
    if (patterns.length === 0) return [];
    conditions.push(Prisma.sql`jel.account_code LIKE ANY(${patterns}::text[])`);
  }

  const where = Prisma.join(conditions, ' AND ');
  // $sum: 1 after $unwind counted lines, not entries — COUNT(*) matches.
  const countSelect = withCount ? Prisma.sql`, COUNT(*)::int AS "count"` : Prisma.empty;

  if (!groupByAccountCode) {
    const rows = await dbClient().$queryRaw`
      SELECT NULL::text AS "accountCode",
             NULL::text AS "_id",
             COALESCE(SUM(jel.debit), 0)::float AS "debit",
             COALESCE(SUM(jel.credit), 0)::float AS "credit"
             ${countSelect}
      FROM journal_entry_lines jel
      INNER JOIN journal_entries je ON je.id = jel.journal_entry_id
      WHERE ${where}
    `;
    // A grand total over no rows is an empty result in Mongo, but one all-zero
    // row in SQL. Drop it so `entries[0]?.debit` behaves as it did.
    return rows.filter((r) => Number(r.debit) !== 0 || Number(r.credit) !== 0 || (withCount && Number(r.count) !== 0));
  }

  return dbClient().$queryRaw`
    SELECT jel.account_code AS "accountCode",
           jel.account_code AS "_id",
           COALESCE(SUM(jel.debit), 0)::float AS "debit",
           COALESCE(SUM(jel.credit), 0)::float AS "credit"
           ${countSelect}
    FROM journal_entry_lines jel
    INNER JOIN journal_entries je ON je.id = jel.journal_entry_id
    WHERE ${where}
    GROUP BY jel.account_code
  `;
}

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
           jel.account_code AS "_id",
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
           jel.account_code AS "_id",
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
           jel.account_code AS "_id",
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
           jel.account_code AS "_id",
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
           jel.account_code AS "_id",
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
           jel.account_code AS "_id",
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
           jel.account_code AS "_id",
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
           jel.account_code AS "_id",
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

  return rows.map((r) 