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
  purchaseOrder: {
    domain: AI_DOMAINS.PURCHASES,
    canonical: 'purchase order',
    aliases: ['po', 'supplier order'],
    requiredFacts: ['Purchase count for selected period'],
  },
  goodsReceivedNote: {
    domain: AI_DOMAINS.PURCHASES,
    canonical: 'goods received note',
    aliases: ['grn', 'goods receipt'],
    requiredFacts: ['Purchase count for selected period'],
  },
  payrollRun: {
    domain: AI_DOMAINS.PAYROLL,
    canonical: 'payroll run',
    aliases: ['pay run', 'salary run'],
    requiredFacts: ['Payroll employer cost for selected period'],
  },
  journalEntry: {
    domain: AI_DOMAINS.FINANCE,
    canonical: 'journal entry',
    aliases: ['ledger entry', 'general ledger posting'],
    requiredFacts: ['Profit and loss revenue', 'Profit and loss net profit'],
  },
  warehouse: {
    domain: AI_DOMAINS.INVENTORY,
    canonical: 'warehouse',
    aliases: ['stock location', 'store location'],
    requiredFacts: ['Total active products', 'Total stock value'],
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
    kpiId: 'vat_collected',
  },
  vatPayable: {
    canonical: 'VAT payable',
    aliases: ['net VAT payable', 'VAT due', 'VAT liability'],
    definition: 'Output VAT less recoverable input VAT for the selected tax period, as reported by the existing tax report service.',
    kpiId: 'vat_payable',
  },
  inventoryTurnover: {
    canonical: 'inventory turnover',
    aliases: ['stock turnover', 'inventory turns'],
    definition: 'Cost of goods sold divided by average inventory value. Ending stock value is a disclosed proxy if average value is unavailable.',
    kpiId: 'inventory_turnover',
  },
  dpo: {
    canonical: 'days payable outstanding',
    aliases: ['dpo', 'supplier payment days', 'payables days'],
    definition: 'Outstanding supplier payables divided by purchases in the selected period, multiplied by the selected period length in days.',
    kpiId: 'days_payable_outstanding',
  },
  deadStock: {
    canonical: 'dead stock',
    aliases: ['non-moving stock', 'slow moving stock with no outbound movement'],
    definition: 'Product with zero outbound StockMovement records in the trailing tenant-configured window; default window is 60 days.',
    kpiId: 'dead_stock_count',
  },
  payrollCostRatio: {
    canonical: 'payroll cost ratio',
    aliases: ['payroll-to-revenue ratio', 'staff cost ratio'],
    definition: 'Employer payroll cost divided by revenue for the same selected period, expressed as a percentage.',
    kpiId: 'payroll_cost_ratio',
  },
});

const RWANDA_TERMS = Object.freeze({
  RWF: {
    canonical: 'Rwandan franc',
    aliases: ['FRW', 'RWF'],
    definition: 'Kubika company base currency label for values denominated in Rwandan francs.',
  },
  VAT: {
    canonical: 'value added tax',
    aliases: ['VAT', 'output tax', 'input tax'],
    definition: 'Tax amounts and payable balances are taken from the company tax report; do not infer a filing amount from sales alone.',
  },
  taxA: {
    canonical: 'Tax A',
    aliases: ['A tax code'],
    definition: 'Kubika invoice tax category. Apply the rate configured for the company and item; do not assume a rate from the label alone.',
  },
  taxB: {
    canonical: 'Tax B',
    aliases: ['B tax code'],
    definition: 'Kubika invoice tax category, commonly configured at 18%; verify the company/item tax configuration for a transaction.',
  },
  RRA: {
    canonical: 'Rwanda Revenue Authority',
    aliases: ['RRA'],
    definition: 'Rwanda tax authority referenced by Kubika tax and EBM workflows.',
  },
  EBM: {
    canonical: 'Electronic Billing Machine',
    aliases: ['EBM', 'EBM/VSDC'],
    definition: 'Electronic invoicing and fiscalization integration used for supported RRA workflows.',
  },
  PAYE: {
    canonical: 'Pay As You Earn',
    aliases: ['PAYE withholding'],
    definition: 'Payroll withholding amount recorded in the payroll report.',
  },
  RSSB: {
    canonical: 'Rwanda Social Security Board contributions',
    aliases: ['RSSB'],
    definition: 'Employee and employer social security contributions recorded separately in payroll reports.',
  },
  withholdingTax: {
    canonical: 'withholding tax',
    aliases: ['WHT', 'withholding'],
    definition: 'Withheld tax liability recorded in tax reports; use report facts for declared and remitted amounts.',
  },
});

const MODULE_RELATIONSHIPS = Object.freeze([
  { from: 'product', relation: 'has', to: 'stock movement' },
  { from: 'product', relation: 'appears in', to: 'invoice line' },
  { from: 'product', relation: 'sourced from', to: 'supplier' },
  { from: 'customer', relation: 'receives', to: 'invoice' },
  { from: 'invoice', relation: 'contains', to: 'invoice line' },
  { from: 'invoice', relation: 'posts to', to: 'journal entry' },
  { from: 'supplier', relation: 'receives', to: 'purchase order' },
  { from: 'purchase order', relation: 'fulfilled by', to: 'goods received note' },
  { from: 'employee', relation: 'included in', to: 'payroll run' },
  { from: 'warehouse', relation: 'locates', to: 'stock movement' },
  { from: 'journal entry', relation: 'posts against', to: 'chart of accounts' },
]);

const BUSINESS_QUESTIONS = Object.freeze([
  { pattern: /\b(gross profit)\b/i, kpiIds: ['gross_profit'], domains: [AI_DOMAINS.FINANCE], requiredFacts: ['Profit and loss revenue', 'Cost of goods sold'] },
  { pattern: /\b(gross margin|profit margin)\b/i, kpiIds: ['gross_margin_pct'], domains: [AI_DOMAINS.FINANCE], requiredFacts: ['Profit and loss revenue', 'Cost of goods sold'] },
  { pattern: /\b(net profit|bottom line)\b/i, kpiIds: ['net_profit'], domains: [AI_DOMAINS.FINANCE], requiredFacts: ['Profit and loss net profit'] },
  { pattern: /\b(inventory turnover|stock turnover|inventory turns)\b/i, kpiIds: ['inventory_turnover'], domains: [AI_DOMAINS.FINANCE, AI_DOMAINS.INVENTORY], requiredFacts: ['Cost of goods sold', 'Average inventory value or Total stock value'] },
  { pattern: /\b(dso|days sales outstanding|collection days)\b/i, kpiIds: ['days_sales_outstanding'], domains: [AI_DOMAINS.CUSTOMERS, AI_DOMAINS.SALES], requiredFacts: ['Total client outstanding balance', 'Sales revenue for selected period'] },
  { pattern: /\b(dpo|days payable outstanding|supplier payment days|payables days)\b/i, kpiIds: ['days_payable_outstanding'], domains: [AI_DOMAINS.PURCHASES], requiredFacts: ['Total supplier outstanding balance', 'Purchases for selected period'] },
  { pattern: /\b(stockout risk|stockout|low stock risk|out of stock risk)\b/i, kpiIds: ['stockout_risk_count'], domains: [AI_DOMAINS.INVENTORY], requiredFacts: ['Low stock product count', 'Out of stock product count'] },
  { pattern: /\b(dead stock|non-moving stock)\b/i, kpiIds: ['dead_stock_count'], domains: [AI_DOMAINS.INVENTORY], requiredFacts: ['Dead stock candidate count'] },
  { pattern: /\b(vat collected|output vat|sales vat)\b/i, kpiIds: ['vat_collected'], domains: [AI_DOMAINS.TAX], requiredFacts: ['VAT collected for selected period'] },
  { pattern: /\b(vat payable|net vat payable|vat due|vat liability)\b/i, kpiIds: ['vat_payable'], domains: [AI_DOMAINS.TAX], requiredFacts: ['VAT payable for selected period'] },
  { pattern: /\b(payroll cost ratio|payroll-to-revenue ratio|staff cost ratio)\b/i, kpiIds: ['payroll_cost_ratio'], domains: [AI_DOMAINS.PAYROLL, AI_DOMAINS.FINANCE], requiredFacts: ['Payroll employer cost for selected period', 'Profit and loss revenue'] },
]);

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

  for (const question of BUSINESS_QUESTIONS) {
    if (question.pattern.test(normalized)) question.domains.forEach((domain) => domains.add(domain));
  }

  return Array.from(domains);
}

function inferKpisFromTerms(text) {
  const normalized = normalizeText(text);
  return Array.from(new Set(BUSINESS_QUESTIONS
    .filter((entry) => entry.pattern.test(normalized))
    .flatMap((entry) => entry.kpiIds)));
}

function resolveBusinessQuestions(text) {
  const normalized = normalizeText(text);
  return BUSINESS_QUESTIONS.filter((entry) => entry.pattern.test(normalized)).map(({ pattern, ...entry }) => entry);
}

module.exports = {
  ENTITY_REGISTRY,
  BUSINESS_TERMS,
  RWANDA_TERMS,
  MODULE_RELATIONSHIPS,
  BUSINESS_QUESTIONS,
  findEntity,
  findBusinessTerm,
  inferDomainsFromTerms,
  inferKpisFromTerms,
  resolveBusinessQuestions,
};
