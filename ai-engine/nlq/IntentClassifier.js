'use strict';

const {
  inferDomainsFromTerms,
  inferKpisFromTerms,
  resolveBusinessQuestions,
} = require('../knowledge-model');

const NLQ_VERSION = 'nlq-v2';

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
  'reject', 'record', 'pay', 'delete', 'void', 'cancel', 'adjust', 'transfer', 'file', 'update', 'process', 'allocate',
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
  { intent: INTENTS.HELP_QUERY, pattern: /\b(how do i|how can i|how to|steps to|guide me to|explain how)\b/i, confidence: 0.9 },
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
  if (/\b(don't|do not|never|shouldn't|should not|without)\b/i.test(normalized)) return null;
  const reportRequest = /\b(report|export|download|excel|spreadsheet|pdf|csv|statement|summary|chart)\b/i.test(normalized);
  if (reportRequest) return null;
  const verbs = ACTION_VERBS.join('|');
  const commandPrefix = new RegExp(`^(please\\s+)?(${verbs})\\b`, 'i');
  const addressedRequest = new RegExp(`\\b(can|could|would) you\\s+(please\\s+)?(${verbs})\\b|\\b(i need|i want) you to\\s+(${verbs})\\b`, 'i');
  const isCommand = commandPrefix.test(normalized);
  const isAddressedRequest = addressedRequest.test(normalized);
  if (!isCommand && !isAddressedRequest) return null;

  for (const entry of ACTION_PATTERNS) {
    if (entry.pattern.test(normalized)) {
      return {
        actionType: entry.type,
        confidence: 0.96,
        reason: `Matched action pattern for ${entry.type}.`,
      };
    }
  }

  if (isCommand || isAddressedRequest) {
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

  const helpIntent = INTENT_PATTERNS.find((entry) => entry.intent === INTENTS.HELP_QUERY && entry.pattern.test(normalized));
  if (helpIntent) {
    return {
      intent: helpIntent.intent,
      confidence: helpIntent.confidence,
      reason: `Matched ${helpIntent.intent} pattern.`,
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
    intent: INTENTS.AMBIGUOUS_QUERY,
    confidence: 0.55,
    reason: 'No deterministic intent pattern matched; clarification or LLM fallback is needed.',
  };
}

function inferKpis(text) {
  return inferKpisFromTerms(text);
}

function classifyQuery(text, options = {}) {
  const normalized = normalize(text);
  const detection = detectIntent(normalized);
  const domains = inferDomainsFromTerms(normalized);
  const kpis = inferKpis(normalized);
  const businessQuestions = resolveBusinessQuestions(normalized);
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
    businessQuestions,
    requiresClarification,
    routesToActionEngine,
    reason: detection.reason,
    metadata: {
      historyLength: Array.isArray(options.history) ? options.history.length : 0,
      deterministic: true,
    },
  };
}

function buildLLMClassificationMessages(query, history = []) {
  const { normalizeHistory } = require('../prompt-builder');
  return [
    {
      role: 'system',
      content: `Classify the user's current request. Return only JSON with {"intent":"${Object.values(INTENTS).join('|')}","actionType":"${Object.values(ACTION_TYPES).join('|')} or null","confidence":0.0,"reason":"short explanation"}. Use ambiguous_query if history and message do not make the intent clear. Use action_intent only when the user is asking to perform a business action. Help/how-to questions about performing actions are help_query. Never claim or perform an action.`,
    },
    ...normalizeHistory(history, 8),
    { role: 'user', content: normalize(query).slice(0, 2000) },
  ];
}

function parseLLMClassification(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (!Object.values(INTENTS).includes(value.intent)) return null;
  const confidence = Number(value.confidence);
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) return null;
  const actionType = value.actionType == null ? null : value.actionType;
  if (actionType != null && !Object.values(ACTION_TYPES).includes(actionType)) return null;
  if (value.intent === INTENTS.ACTION_INTENT && !actionType) return null;
  if (value.intent !== INTENTS.ACTION_INTENT && actionType) return null;
  return {
    intent: value.intent,
    actionType,
    confidence,
    reason: typeof value.reason === 'string' ? value.reason.slice(0, 240) : 'Classified from conversation context.',
  };
}

function applyLLMClassification(deterministic, candidate) {
  if (!deterministic || !candidate || candidate.confidence < 0.65) return deterministic;
  const requiresClarification = candidate.intent === INTENTS.AMBIGUOUS_QUERY;
  return {
    ...deterministic,
    intent: candidate.intent,
    confidence: candidate.confidence,
    actionType: candidate.actionType,
    requiresClarification,
    routesToActionEngine: candidate.intent === INTENTS.ACTION_INTENT,
    reason: candidate.reason,
    metadata: {
      ...deterministic.metadata,
      deterministic: false,
      classifier: 'llm-fallback',
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
  buildLLMClassificationMessages,
  parseLLMClassification,
  applyLLMClassification,
  actionProposalReply,
  clarificationReply,
};
