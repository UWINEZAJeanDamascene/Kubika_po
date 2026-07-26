require('dotenv').config();
const { prisma } = require('../lib/prisma');

(async () => {
  const dn = await prisma.deliveryNote.findUnique({
    where: { id: '41a76188fe3872d5d10ca350' },
    include: { lines: true },
  });
  console.log('DN', JSON.stringify({
    id: dn?.id,
    ref: dn?.referenceNo,
    status: dn?.status,
    invoiceId: dn?.invoiceId,
    sourceType: dn?.sourceType,
    salesOrderId: dn?.salesOrderId,
    lineCount: dn?.lines?.length,
    lines: dn?.lines?.map(l => ({
      productId: l.productId,
      productName: l.productName,
      qtyToDeliver: String(l.qtyToDeliver),
      unitPrice: String(l.unitPrice),
      invoiceLineId: l.invoiceLineId,
    })),
  }, null, 2));

  const inv = await prisma.invoice.findUnique({
    where: { id: 'e5ea1c5aa72b90a158878692' },
    include: { lines: true },
  });
  console.log('INV', JSON.stringify({
    id: inv?.id,
    ref: inv?.referenceNo,
    status: inv?.status,
    currencyCode: inv?.currencyCode,
    deliveryNoteId: inv?.deliveryNoteId,
    salesOrderId: inv?.salesOrderId,
    subtotal: String(inv?.subtotal),
    totalAmount: String(inv?.totalAmount),
    lines: inv?.lines?.map(l => ({
      unitCost: String(l.unitCost),
      cogsAmount: String(l.cogsAmount),
      qty: String(l.qty),
      unitPrice: String(l.unitPrice),
    })),
  }, null, 2));

  await prisma.$disconnect();
})().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
