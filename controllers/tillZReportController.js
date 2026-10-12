const { prisma } = require('../lib/prisma');

const number = (value) => Number(value || 0);
const roundMoney = (value) => Math.round((number(value) + Number.EPSILON) * 100) / 100;

async function buildReport(companyId, till) {
  const endAt = till.closedAt || new Date();
  const invoices = await prisma.$queryRawUnsafe(
    `SELECT id, reference_no, status, subtotal, total_discount, tax_amount, total_amount,
            payments, cancelled_at, invoice_date
       FROM invoices
      WHERE company_id = $1 AND till_session_id = $2
      ORDER BY invoice_date, id`,
    companyId, till.id,
  );
  const lineRows = await prisma.$queryRawUnsafe(
    `SELECT il.tax_code, SUM(il.line_subtotal * (1 - il.discount_pct / 100)) AS taxable,
            SUM(il.line_tax) AS tax
       FROM invoice_lines il
       JOIN invoices i ON i.id = il.invoice_id AND i.company_id = il.company_id
      WHERE i.company_id = $1 AND i.till_session_id = $2 AND i.status <> 'cancelled'
      GROUP BY il.tax_code ORDER BY il.tax_code`,
    companyId, till.id,
  );
  const refundRows = await prisma.$queryRawUnsafe(
    `SELECT cn.reference_no, refund->>'paymentMethod' AS payment_method,
            refund->>'reference' AS payment_reference,
            COALESCE((refund->>'amount')::numeric, 0) AS amount,
            refund->>'refundedAt' AS refunded_at
       FROM credit_notes cn
       CROSS JOIN LATERAL jsonb_array_elements(COALESCE(cn.payments, '[]'::jsonb)) AS refund
      WHERE cn.company_id = $1 AND refund->>'tillSessionId' = $2
      ORDER BY refund->>'refundedAt'`,
    companyId, till.id,
  );
  const legacySaleRows = await prisma.$queryRawUnsafe(
    `SELECT COUNT(*)::int AS count FROM invoices
      WHERE company_id = $1 AND pos_origin = true AND till_session_id IS NULL
        AND created_by = $2 AND invoice_date >= $3 AND invoice_date <= $4`,
    companyId, till.openedById, till.openedAt, endAt,
  );
  const legacyRefundRows = await prisma.$queryRawUnsafe(
    `SELECT COUNT(*)::int AS count
       FROM credit_notes cn
       CROSS JOIN LATERAL jsonb_array_elements(COALESCE(cn.payments, '[]'::jsonb)) AS refund
      WHERE cn.company_id = $1 AND cn.pos_origin = true
        AND refund->>'tillSessionId' IS NULL
        AND refund->>'refundedBy' = $2
        AND (refund->>'refundedAt')::timestamptz >= $3
        AND (refund->>'refundedAt')::timestamptz <= $4`,
    companyId, till.openedById, till.openedAt, endAt,
  );

  const completed = invoices.filter((invoice) => invoice.status !== 'cancelled');
  const voided = invoices.filter((invoice) => invoice.status === 'cancelled'
    && invoice.cancelled_at && new Date(invoice.cancelled_at) >= new Date(till.openedAt)
    && new Date(invoice.cancelled_at) <= new Date(endAt));
  const sales = completed.reduce((total, invoice) => ({
    gross: total.gross + number(invoice.subtotal),
    discounts: total.discounts + number(invoice.total_discount),
    tax: total.tax + number(invoice.tax_amount),
    total: total.total + number(invoice.total_amount),
  }), { gross: 0, discounts: 0, tax: 0, total: 0 });
  const tenderTotals = new Map();
  for (const invoice of invoices) {
    if (invoice.status === 'cancelled') continue;
    const payments = Array.isArray(invoice.payments) ? invoice.payments : [];
    for (const payment of payments) {
      const amount = number(payment?.amount);
      if (amount <= 0) continue;
      const method = String(payment.paymentMethod || 'unknown').toLowerCase();
      tenderTotals.set(method, (tenderTotals.get(method) || 0) + amount);
    }
  }
  const refundsByMethod = new Map();
  let totalRefunds = 0;
  let cashRefunds = 0;
  for (const refund of refundRows) {
    const amount = number(refund.amount);
    const method = String(refund.payment_method || 'unknown').toLowerCase();
    refundsByMethod.set(method, (refundsByMethod.get(method) || 0) + amount);
    totalRefunds += amount;
    if (method === 'cash') cashRefunds += amount;
  }
  const methodNames = new Set([...tenderTotals.keys(), ...refundsByMethod.keys()]);
  const tenders = [...methodNames].sort().map((method) => {
    const received = roundMoney(tenderTotals.get(method) || 0);
    const refunded = roundMoney(refundsByMethod.get(method) || 0);
    return { method, received, refunded, net: roundMoney(received - refunded) };
  });
  const cashActivity = Array.isArray(till.cashActivity) ? till.cashActivity : [];
  const cashSales = roundMoney(cashActivity
    .filter((activity) => activity.type === 'cash_sale')
    .reduce((sum, activity) => sum + number(activity.amount), 0));
  const openingFloat = roundMoney(till.openingFloat);
  const expectedCash = roundMoney(till.expectedCash ?? openingFloat);
  const computedExpectedCash = roundMoney(openingFloat + cashSales - cashRefunds);
  const countedCash = till.closingCount == null ? null : roundMoney(till.closingCount);
  const taxBuckets = lineRows.map((row) => ({
    code: row.tax_code || 'UNASSIGNED',
    taxable: roundMoney(row.taxable),
    tax: roundMoney(row.tax),
  }));
  const voidTotal = voided.reduce((sum, invoice) => sum + number(invoice.total_amount), 0);

  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    shift: {
      id: till.id,
      registerId: till.registerId,
      registerName: till.registerName,
      cashierId: till.openedById,
      cashier: till.openedBy ? { id: till.openedBy.id, name: till.openedBy.name, email: till.openedBy.email } : null,
      status: till.status,
      openedAt: till.openedAt,
      closedAt: till.closedAt,
    },
    sales: {
      transactionCount: completed.length,
      gross: roundMoney(sales.gross),
      discounts: roundMoney(sales.discounts),
      netBeforeTax: roundMoney(sales.gross - sales.discounts),
      tax: roundMoney(sales.tax),
      total: roundMoney(sales.total),
    },
    tenders,
    voids: { count: voided.length, total: roundMoney(voidTotal), invoices: voided.map((invoice) => ({ reference: invoice.reference_no, total: roundMoney(invoice.total_amount), voidedAt: invoice.cancelled_at })) },
    refunds: { count: refundRows.length, total: roundMoney(totalRefunds), byMethod: [...refundsByMethod].map(([method, amount]) => ({ method, amount: roundMoney(amount) })) },
    taxBuckets,
    cash: {
      openingFloat,
      cashSales,
      cashRefunds: roundMoney(cashRefunds),
      expectedCash,
      computedExpectedCash,
      count: countedCash,
      variance: countedCash == null ? null : roundMoney(countedCash - expectedCash),
      ledgerDifference: roundMoney(expectedCash - computedExpectedCash),
    },
    completeness: {
      linkedSales: invoices.length,
      unlinkedLegacySales: Number(legacySaleRows[0]?.count || 0),
      unlinkedLegacyRefunds: Number(legacyRefundRows[0]?.count || 0),
      hasLegacyUnlinkedSales: Number(legacySaleRows[0]?.count || 0) > 0,
      hasLegacyUnlinkedRefunds: Number(legacyRefundRows[0]?.count || 0) > 0,
      refundsLinked: refundRows.length,
    },
  };
}

exports.getTillZReport = async (req, res, next) => {
  try {
    const companyId = String(req.user.company?._id || req.user.companyId || '');
    const tillId = String(req.params.tillSessionId || '');
    const rows = await prisma.$queryRawUnsafe(
      `SELECT ts.id, ts.company_id AS "companyId", ts.opened_by AS "openedById",
              ts.register_id AS "registerId", ts.register_name AS "registerName", ts.status,
              ts.opening_float AS "openingFloat", ts.expected_cash AS "expectedCash",
              ts.closing_count AS "closingCount", ts.cash_activity AS "cashActivity",
              ts.opened_at AS "openedAt", ts.closed_at AS "closedAt", ts.z_report AS "zReport",
              u.id AS "cashierId", u.name AS "cashierName", u.email AS "cashierEmail"
         FROM till_sessions ts LEFT JOIN users u ON u.id = ts.opened_by
        WHERE ts.id = $1 AND ts.company_id = $2`,
      tillId, companyId,
    );
    const till = rows[0] ? {
      ...rows[0],
      openedBy: rows[0].cashierId ? { id: rows[0].cashierId, name: rows[0].cashierName, email: rows[0].cashierEmail } : null,
    } : null;
    if (!till) return res.status(404).json({ success: false, code: 'POS_TILL_NOT_FOUND', message: 'Till shift not found.' });

    if (till.zReport) return res.json({ success: true, data: till.zReport });
    const report = await buildReport(companyId, till);
    if (till.status === 'closed') {
      const stored = await prisma.$queryRawUnsafe(
        'UPDATE till_sessions SET z_report = $1::jsonb, z_report_generated_at = CURRENT_TIMESTAMP WHERE id = $2 AND company_id = $3 AND status = \'closed\' AND z_report IS NULL RETURNING z_report',
        JSON.stringify(report), till.id, companyId,
      );
      if (!stored.length) {
        const currentRows = await prisma.$queryRawUnsafe(
          'SELECT z_report AS "zReport" FROM till_sessions WHERE id = $1 AND company_id = $2',
          till.id, companyId,
        );
        const current = currentRows[0];
        if (current?.zReport) return res.json({ success: true, data: current.zReport });
      }
    }
    return res.json({ success: true, data: report });
  } catch (error) {
    console.error('[getTillZReport] Failed to build or persist shift report:', error);
    return next(error);
  }
};
