'use strict';

const { AI_DOMAINS } = require('../shared/interfaces');

const ENTITY_REGISTRY = Object.freeze({
  invoice: {
    domain: AI_DOMAINS.SALES,
    canonical: 'invoice',
    aliases: ['sales invoice', 'bill', 'customer invoice'],
    requiredFacts: ['Sales revenue for selected period', 'Invoice count for selected period'],
  },
  product: {
    domain: AI_DOMAINS.INVENTORY,
    canonical: 'product',
    aliases: ['item', 'sku', 'stock item'],
    requiredFacts: ['Total active products', 'Total stock value', 'Low stock product count'],
  },
  purchase: {
    domain: AI_DOMAINS.PURCHASES,
    canonical: 'purchase',
    aliases: ['supplier invoice', 'procurement', 'buying'],
    requiredFacts: ['Purchase count for selected period'],
  },
  client: {
    domain: AI_DOMAINS.CUSTOMERS,
    canonical: 'client',
    aliases: ['customer', 'debtor'],
    requiredFacts: ['Client count', 'Total client outstanding balance', 'Receivables aging'],
  },
  supplier: {
    domain: AI_DOMAINS.SUPPLIERS,
    canonical: 'supplier',
    aliases: ['vendor', 'creditor'],
    requiredFacts: ['Supplier count'],
  },
  cash: {
    domain: AI_DOMAINS.FINANCE,
    canonical: 'cash',
    aliases: ['bank balance', 'cash position', 'available cash'],
    requiredFacts: ['Cash and bank account balance'],
  },
  profitAndLoss: {
    domain: AI_DOMAINS.FINANCE,
    canonical: 'profit and loss',
    aliases: ['p&l', 'income statement', 'profit loss'],
    requiredFacts: ['Profit and loss revenue', 'Profit and loss net profit'],
  },
});

const BUSINESS_TERMS = Object.freeze({
  grossProfit: {
    canonical: 'gross profit',
    aliases: ['gross income'],
    definition: 'Revenue minus cost of goods sold.',
    kpiId: 'gross_profit',
  },
  grossMargin: {
    canonical: 'gross margin',
    aliases: ['gross profit margin', 'margin'],
    definition: 'Gross profit divided by revenue, expressed as a percentage.',
    kpiId: 'gross_margin_pct',
  },
  netProfit: {
    canonical: 'net profit',
    aliases: ['bottom line', 'profit after expenses'],
    definition: 'Profit after expenses and tax for the selected period.',
    kpiId: 'net_profit',
  },
  stockoutRisk: {
    canonical: 'stockout risk',
    aliases: ['out of stock risk', 'low stock risk'],
    definition: 'Operational risk indicated by low stock and out-of-stock product counts.',
    kpiId: 'stockout_risk_count',
  },
  dso: {
    canonical: 'days sales outstanding',
    aliases: ['dso', 'collection days'],
    definition: 'Receivable collection speed estimated from outstanding receivables and revenue.',
    kpiId: 'days_sales_outstanding',
  },
  vatCollected: {
    canonical: 'VAT collected',
    aliases: ['output VAT', 'sales VAT'],
    definition: 'VAT collected from taxable sales. Rwanda standard VAT is 18% when Tax B applies.',
    kpiId: 'vat_collected_estimate',
  },
});

function normalizeText(value) {
  return String(value || '').trim().toLowerCase();
}

function findEntity(term) {
  const normalized = normalizeText(term);
  for (const entity of Object.values(ENTITY_REGISTRY)) {
    if (entity.canonical === normalized || entity.aliases.some((alias) => normalizeText(alias) === normalized)) {
      return entity;
    }
  }
  return null;
}

function findBusinessTerm(term) {
  const normalized = normalizeText(term);
  for (const businessTerm of Object.values(BUSINESS_TERMS)) {
    if (
      normalizeText(businessTerm.canonical) === normalized ||
      businessTerm.aliases.some((alias) => normalizeText(alias) === normalized)
    ) {
      return businessTerm;
    }
  }
  return null;
}

function inferDomainsFromTerms(text) {
  const normalized = normalizeText(text);
  const domains = new Set();

  for (const entity of Object.values(ENTITY_REGISTRY)) {
    const terms = [entity.canonical, ...entity.aliases].map(normalizeText);
    if (terms.some((term) => normalized.includes(term))) domains.add(entity.domain);
  }

  return Array.from(domains);
}

module.exports = {
  ENTITY_REGISTRY,
  BUSINESS_TERMS,
  findEntity,
  findBusinessTerm,
  inferDomainsFromTerms,
};

