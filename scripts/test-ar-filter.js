require('dotenv').config();
const mongoose = require('mongoose');
const { connectPrisma, prisma } = require('../lib/prisma');
const Invoice = require('../models/Invoice');

const companyId = '6a1682833035c524d960189e';

(async () => {
  await connectPrisma();

  const prismaRows = await prisma.invoice.findMany({
    where: {
      companyId,
      amountOutstanding: { gt: 0 },
      status: { in: ['partially_paid', 'confirmed', 'sent'] },
    },
    select: { referenceNo: true, amountOutstanding: true, status: true },
  });
  console.log('Prisma direct:', prismaRows.length, prismaRows);

  for (const company of [companyId, new mongoose.Types.ObjectId(companyId)]) {
    const rows = await Invoice.find({
      company,
      status: { $in: ['partially_paid', 'confirmed', 'sent'] },
      amountOutstanding: { $gt: 0 },
    }).lean();
    console.log('Invoice.find company type', typeof company, 'count', rows.length);
  }

  const rows2 = await Invoice.find({
    company: companyId,
    status: { $in: ['partially_paid', 'confirmed', 'sent'] },
  }).lean();
  console.log('Without outstanding filter:', rows2.length, rows2.slice(0, 3).map((r) => ({
    ref: r.referenceNo,
    outstanding: r.amountOutstanding,
    status: r.status,
  })));

  process.exit(0);
})().catch(console.error);
