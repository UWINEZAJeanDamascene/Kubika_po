'use strict';

const { inferDomainsFromTerms, findBusinessTerm } = require('../knowledge-model');

const NLQ_VERSION = 'nlq-v1';

const INTENTS = Object.freeze({
  FACTUAL_QUERY: 'factual_query',
  ANALYTICAL_QUERY: 'analytical_query',
  CAUSAL_QUERY: 'causal_query',
  FORECAST_QUERY: 'forecast_query',
  REPORT_REQUEST: 'report_request',
  RECOMMENDATION_REQUEST: 'recommendation_request',
  ACTION_INTENT: 'action_intent',
  HELP_QUERY: 'help_query',
  AMBIGUOUS_QUERY: 'ambiguous_query',
});

const ACTION_TYPES = Object.freeze({
  CREATE_PURCHASE_ORDER: 'create_purchase_order',
  SEND_PAYMENT_REMINDER: 'send_payment_reminder',
  CREATE_INVOICE: 'create_invoice',
  POST_JOURNAL_ENTRY: 'post_journal_entry',
  RECORD_PAYMENT: 'record_payment',
  ADJUST_STOCK: 'adjust_stock',
  SUBMIT_TAX_RETURN: 'submit_tax_return',
  APPROVE_DOCUMENT: 'approve_document',
  DELETE_OR_VOID: 'delete_or_void',
  GENERIC_ACTION: 'generic_action',
});

const ACTION_VERBS = [
  'create', 'generate', 'make', 'draft', 'send', 'email', 'post', 'submit', 'approve',
  'reject', 'record', 'pay', 'delete', 'void', 'cancel', 'adjust', 'transfer', 'file',
];

const ACTION_PATTERNS = [
  { type: ACTION_TYPES.CREATE_PURCHASE_ORDER, pattern: /\b(create|generate|make|draft)\b.*\b(purchase order|po)\b/i },
  { type: ACTION_TYPES.SEND_PAYMENT_REMINDER, pattern: /\b(send|email)\b.*\b(payment reminder|reminder)\b/i },
  { type: ACTION_TYPES.CREATE_INVOICE, pattern: /\b(create|generate|make|draft)\b.*\b(invoice|sales invoice)\b/i },
  { type: ACTION_TYPES.POST_JOURNAL_ENTRY, pattern: /\b(post|create|record)\b.*\b(journal entry|ledger entry)\b/i },
  { type: ACTION_TYPES.RECORD_PAYMENT, pattern: /\b(record|pay|settle|allocate)\b.*\b(payment|receipt)\b/i },
  { type: ACTION_TYPES.ADJUST_STOCK, pattern: /\b(adjust|transfer|write off|write-off)\b.*\b(stock|inventory)\b/i },
  { type: ACTION_TYPES.SUBMIT_TAX_RETURN, pattern: /\b(submit|file)\b.*\b(vat|tax return|tax filing)\b/i },
  { type: ACTION_TYPES.APPROVE_DOCUMENT, pattern: /\b(approve|reject)\b.*\b(invoice|purchase order|payment|budget|expense|document)\b/i },
  { type: ACTION_TYPES.DELETE_OR_VOID, pattern: /\b(delete|void|cancel)\b.*\b(invoice|purchase order|payment|journal|stock|document)\b/i },
];

const INTENT_PATTERNS = [
  { intent: INTENTS.CAUSAL_QUERY, pattern: /\b(why|what caused|reason|cause|explain why|because of what)\b/i, confidence: 0.9 },
  { intent: INTENTS.FORECAST_QUERY, pattern: /\b(predict|forecast|projection|next month|next quarter|future|will we|expected)\b/i, confidence: 0.88 },
  { intent: INTENTS.REPORT_REQUEST, pattern: /\b(report|export|download|pdf|excel|csv|statement|summary)\b/i, confidence: 0.84 },
  { intent: INTENTS.RECOMMENDATION_REQUEST, pattern: /\b(recommend|suggest|should i|what should|best action|next step|priority)\b/i, confidence: 0.86 },
  { intent: INTENTS.HELP_QUERY, pattern: /\b(how do i|how to|help|guide|steps|tutorial|where can i)\b/i, confidence: 0.82 },
  { intent: INTENTS.ANALYTICAL_QUERY, pattern: /\b(compare|analyze|analysis|trend|ratio|margin|performance|top|lowest|highest|risk)\b/i, confidence: 0.8 },
  { intent: INTENTS.FACTUAL_QUERY, pattern: /\b(what is|what are|show me|list|how much|how many|current|balance|total)\b/i, confidence: 0.74 },
];

const AMBIGUOUS_PATTERNS = [
  /^\s*(it|that|this|they|them|those)\??\s*$/i,
  /^\s*(yes|no|ok|okay|sure|do it|continue)\s*$/i,
];

function normalize(text) {
  return String(text || '').trim();
}

function detectAction(text) {
  const normalized = normalize(text);
  for (const entry of ACTION_PATTERNS) {
    if (entry.pattern.test(normalized)) {
      return {
        actionType: entry.type,
        confidence: 0.96,
        reason: `Matched action pattern for ${entry.type}.`,
      };
    }
  }

  const lower = normalized.toLowerCase();
  if (ACTION_VERBS.some((verb) => lower.startsWith(`${verb} `))) {
    return {
      actionType: ACTION_TYPES.GENERIC_ACTION,
      confidence: 0.78,
      reason: 'Started with a mutating/action verb.',
    };
  }

  return null;
}

function detectIntent(text) {
  const normalized = normalize(text);
  if (!normalized) {
    return {
      intent: INTENTS.AMBIGUOUS_QUERY,
      confidence: 0.99,
      reason: 'Empty query.',
    };
  }

  if (AMBIGUOUS_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return {
      intent: INTENTS.AMBIGUOUS_QUERY,
      confidence: 0.9,
      reason: 'Query is too short or depends on missing prior context.',
    };
  }

  const action = detectAction(normalized);
  if (action) {
    return {
      intent: INTENTS.ACTION_INTENT,
      confidence: action.confidence,
      actionType: action.actionType,
      reason: action.reason,
    };
  }

  for (const entry of INTENT_PATTERNS) {
    if (entry.pattern.test(normalized)) {
      return {
        intent: entry.intent,
        confidence: entry.confidence,
        reason: `Matched ${entry.intent} pattern.`,
      };
    }
  }

  return {
    intent: INTENTS.FACTUAL_QUERY,
    confidence: 0.55,
    reason: 'Defaulted to factual query.',
  };
}

function inferKpis(text) {
  const lower = normalize(text).toLowerCase();
  const kpis = new Set();
  const directTerms = ['gross profit', 'gross margin', 'net profit', 'dso', 'days sales outstanding', 'stockout risk', 'vat collected'];

  for (const term of directTerms) {
    if (!lower.includes(term)) continue;
    const businessTerm = findBusinessTerm(term);
    if (businessTerm && businessTerm.kpiId) kpis.add(businessTerm.kpiId);
  }

  if (/\blow stock|out of stock|stockout|stock risk\b/i.test(lower)) kpis.add('stockout_risk_count');
  if (/\bmargin\b/i.test(lower)) kpis.add('gross_margin_pct');
  if (/\bnet profit|profit\b/i.test(lower)) kpis.add('net_profit');
  if (/\bvat\b/i.test(lower)) kpis.add('vat_collected_estimate');

  return Array.from(kpis);
}

function classifyQuery(text, options = {}) {
  const normalized = normalize(text);
  const detection = detectIntent(normalized);
  const domains = inferDomainsFromTerms(normalized);
  const kpis = inferKpis(normalized);
  const requiresClarification = detection.intent === INTENTS.AMBIGUOUS_QUERY;
  const routesToActionEngine = detection.intent === INTENTS.ACTION_INTENT;

  return {
    version: NLQ_VERSION,
    query: normalized,
    intent: detection.intent,
    confidence: detection.confidence,
    actionType: detection.actionType || null,
    domains,
    kpis,
    requiresClarification,
    routesToActionEngine,
    reason: detection.reason,
    metadata: {
      historyLength: Array.isArray(options.history) ? options.history.length : 0,
      deterministic: true,
    },
  };
}

function actionProposalReply(classification) {
  const action = classification.actionType || ACTION_TYPES.GENERIC_ACTION;
  return [
    'I can prepare that as an AI action proposal, but I cannot execute it directly from chat.',
    `Detected action intent: ${action}.`,
    'Use POST /api/ai/proposals to create a draft proposal, then approve it before any execution attempt.',
  ].join('\n');
}

function clarificationReply() {
  return 'Can you clarify what business area or record you mean? For example: sales, stock, cash, receivables, purchases, or a specific customer/supplier.';
}

module.exports = {
  NLQ_VERSION,
  INTENTS,
  ACTION_TYPES,
  classifyQuery,
  actionProposalReply,
  clarificationReply,
};

