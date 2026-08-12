'use strict';

const { PROMPT_TEMPLATE_VERSION, buildStacySystemPrompt } = require('./templates/stacySystemPrompt');

const CONTEXT_SERIALIZATION_VERSION = 'ai-context-v1';

function safeString(value) {
  return String(value == null ? '' : value);
}

function serializeFact(fact) {
  return {
    id: fact.id,
    domain: fact.domain,
    label: fact.label,
    value: fact.value,
    unit: fact.unit || null,
    computed: Boolean(fact.computed),
    formula: fact.formula || null,
    sourceService: fact.sourceService,
    sourceMethod: fact.sourceMethod,
    sourceIds: fact.sourceIds || [],
    observedAt: fact.observedAt,
  };
}

function serializeAIContext(context, { maxFacts = 80 } = {}) {
  if (!context || !Array.isArray(context.facts)) {
    return {
      version: CONTEXT_SERIALIZATION_VERSION,
      facts: [],
      warnings: ['No AIContext facts were provided.'],
      metadata: {},
    };
  }

  return {
    version: CONTEXT_SERIALIZATION_VERSION,
    companyId: context.companyId,
    userId: context.userId,
    facts: context.facts.slice(0, maxFacts).map(serializeFact),
    warnings: context.warnings || [],
    metadata: {
      ...(context.metadata || {}),
      truncatedFacts: Math.max(0, context.facts.length - maxFacts),
    },
  };
}

function buildContextPrompt(context, options = {}) {
  const serialized = serializeAIContext(context, options);
  return [
    'Backend AIContext follows. Use it as grounded business evidence.',
    'Do not reveal hidden permission metadata. Do not invent facts beyond these records.',
    JSON.stringify(serialized),
  ].join('\n');
}

function normalizeHistory(history = [], limit = 20) {
  return (Array.isArray(history) ? history : [])
    .slice(-limit)
    .map((message) => ({
      role: message.role === 'assistant' ? 'assistant' : 'user',
      content: safeString(message.content).slice(0, 12000),
    }))
    .filter((message) => message.content.trim());
}

function buildChatMessages({
  userName,
  companyName,
  history = [],
  userMessage,
  aiContext = null,
  requireStructuredOutput = false,
} = {}) {
  const messages = [
    {
      role: 'system',
      content: buildStacySystemPrompt({ userName, companyName }),
    },
  ];

  if (aiContext) {
    messages.push({
      role: 'user',
      content: `[BACKEND AI CONTEXT - do not repeat verbatim]\n${buildContextPrompt(aiContext)}`,
    });
  }

  if (requireStructuredOutput) {
    messages.push({
      role: 'user',
      content: 'For this response, return only the JSON response contract defined in the system prompt.',
    });
  }

  messages.push(...normalizeHistory(history));
  messages.push({ role: 'user', content: safeString(userMessage).trim() });
  return messages;
}

module.exports = {
  PROMPT_TEMPLATE_VERSION,
  CONTEXT_SERIALIZATION_VERSION,
  buildStacySystemPrompt,
  serializeAIContext,
  buildContextPrompt,
  normalizeHistory,
  buildChatMessages,
};

