'use strict';

const { AI_DOMAINS, FINDING_SEVERITIES } = require('../../shared/interfaces');
const { objectFact } = require('../factAccess');
const { createFinding } = require('../findingFactory');

function paymentDay(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
}

function findDuplicateCandidates(payments = []) {
  const groups = new Map();
  for (const payment of payments) {
    const amount = Number(payment.amountPaid);
    const day = paymentDay(payment.paymentDate);
    const supplier = String(payment.supplier || '').trim().toLowerCase();
    if (!Number.isFinite(amount) || amount <= 0 || !day || !supplier) continue;
    const key = `${supplier}|${amount.toFixed(2)}|${day}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(payment);
  }
  return [...groups.values()].filter((group) => group.length > 1);
}

function evaluateDuplicatePayments(context) {
  const paymentsFact = objectFact(context, 'Accounts payable payment sample');
  const candidates = findDuplicateCandidates(Array.isArray(paymentsFact.value) ? paymentsFact.value : []);
  if (!paymentsFact.fact || !candidates.length) return [];
  const references = candidates.flat().map((payment) => payment.paymentNumber).filter(Boolean);
  return [createFinding({
    companyId: context.companyId,
    ruleId: 'finance.possible_duplicate_supplier_payment',
    domain: AI_DOMAINS.FINANCE,
    title: 'Potential duplicate supplier payments need review',
    summary: `${candidates.length} payment group(s) share supplier, amount, and payment date. This is a review flag, not confirmation of duplicate settlement.`,
    severity: FINDING_SEVERITIES.MEDIUM,
    evidenceFacts: [paymentsFact.fact],
    recommendedNextStep: 'Compare the flagged payment references against bank statements and supplier invoices before taking action.',
    metadata: {
      candidateGroups: candidates.length,
      paymentReferences: references.slice(0, 30),
      ruleCertainty: 0.68,
      expectedEvidenceCount: 1,
      modelUncertainty: 0.25,
    },
  })];
}

module.exports = {
  rulePackId: 'payment_anomalies',
  findDuplicateCandidates,
  evaluate: evaluateDuplicatePayments,
};
