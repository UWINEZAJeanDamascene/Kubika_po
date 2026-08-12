'use strict';

const FACT_TYPES = Object.freeze({
  FACT: 'FACT',
  ANALYSIS: 'ANALYSIS',
  PREDICTION: 'PREDICTION',
  RECOMMENDATION: 'RECOMMENDATION',
  ASSUMPTION: 'ASSUMPTION',
});

const AI_DOMAINS = Object.freeze({
  SALES: 'sales',
  INVENTORY: 'inventory',
  FINANCE: 'finance',
  PAYROLL: 'payroll',
  PURCHASES: 'purchases',
  CUSTOMERS: 'customers',
  SUPPLIERS: 'suppliers',
  REPORTS: 'reports',
  TAX: 'tax',
  SECURITY: 'security',
  GENERAL: 'general',
});

const FINDING_SEVERITIES = Object.freeze({
  INFO: 'info',
  LOW: 'low',
  MEDIUM: 'medium',
  HIGH: 'high',
  CRITICAL: 'critical',
});

const PROPOSAL_STATUSES = Object.freeze({
  DRAFT: 'draft',
  PENDING_APPROVAL: 'pending_approval',
  APPROVED: 'approved',
  REJECTED: 'rejected',
  EXECUTED: 'executed',
  FAILED: 'failed',
});

const RECOMMENDATION_TYPES = Object.freeze({
  INFORMATIONAL: 'informational',
  ACTION_CANDIDATE: 'action_candidate',
});

/**
 * @typedef {object} FactRecord
 * @property {string} id
 * @property {string} companyId
 * @property {string} domain
 * @property {string} label
 * @property {*} value
 * @property {string|null} [unit]
 * @property {string} sourceType
 * @property {string} sourceService
 * @property {string} sourceMethod
 * @property {string[]} sourceIds
 * @property {boolean} computed
 * @property {string|null} [formula]
 * @property {string[]} permissions
 * @property {string} observedAt
 */

/**
 * @typedef {object} AIContext
 * @property {string} companyId
 * @property {string} userId
 * @property {string[]} permissions
 * @property {FactRecord[]} facts
 * @property {string[]} warnings
 * @property {object} metadata
 */

/**
 * @typedef {object} AIResponse
 * @property {string} answer
 * @property {{ text: string, type: string, factIds: string[] }[]} claimLabels
 * @property {string[]} missingData
 * @property {AIRecommendation[]} recommendedActions
 * @property {{ provider?: string, model?: string, promptVersion?: string, knowledgeModelVersion?: string }} metadata
 */

/**
 * @typedef {object} AIFinding
 * @property {string} id
 * @property {string} companyId
 * @property {string} domain
 * @property {string} title
 * @property {string} summary
 * @property {string} severity
 * @property {number} confidence
 * @property {string[]} evidenceFactIds
 * @property {string} status
 * @property {string} createdAt
 */

/**
 * @typedef {object} AIRecommendation
 * @property {string} id
 * @property {string} companyId
 * @property {string} type
 * @property {string} title
 * @property {string} rationale
 * @property {number} priorityScore
 * @property {number} confidence
 * @property {string[]} evidenceFactIds
 */

/**
 * @typedef {object} AIActionProposal
 * @property {string} id
 * @property {string} companyId
 * @property {string} createdBy
 * @property {string} type
 * @property {string} status
 * @property {object} payload
 * @property {string[]} evidenceFactIds
 * @property {string} riskLevel
 * @property {string|null} approvedBy
 * @property {string|null} executedAt
 * @property {object|null} executionResult
 */

/**
 * @typedef {object} AIForecast
 * @property {string} id
 * @property {string} companyId
 * @property {string} domain
 * @property {string} metric
 * @property {Array<{ date: string, value: number, lowerBound: number, upperBound: number }>} series
 * @property {string[]} assumptions
 * @property {string[]} sourceFactIds
 * @property {string} modelVersion
 * @property {string} generatedAt
 */

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validateFactRecord(fact) {
  if (!isPlainObject(fact)) return ['FactRecord must be an object'];

  const errors = [];
  const requiredStrings = [
    'id',
    'companyId',
    'domain',
    'label',
    'sourceType',
    'sourceService',
    'sourceMethod',
    'observedAt',
  ];

  for (const field of requiredStrings) {
    if (typeof fact[field] !== 'string' || fact[field].trim() === '') {
      errors.push(`${field} must be a non-empty string`);
    }
  }

  if (!Object.values(AI_DOMAINS).includes(fact.domain)) {
    errors.push(`domain must be one of: ${Object.values(AI_DOMAINS).join(', ')}`);
  }

  if (!Object.prototype.hasOwnProperty.call(fact, 'value')) {
    errors.push('value is required');
  }

  if (!Array.isArray(fact.sourceIds)) {
    errors.push('sourceIds must be an array');
  }

  if (typeof fact.computed !== 'boolean') {
    errors.push('computed must be a boolean');
  }

  if (!Array.isArray(fact.permissions)) {
    errors.push('permissions must be an array');
  }

  return errors;
}

function assertValidFactRecord(fact) {
  const errors = validateFactRecord(fact);
  if (errors.length) {
    throw new Error(`Invalid FactRecord: ${errors.join('; ')}`);
  }
  return fact;
}

function validateAIContext(context) {
  if (!isPlainObject(context)) return ['AIContext must be an object'];

  const errors = [];
  if (typeof context.companyId !== 'string' || !context.companyId.trim()) {
    errors.push('companyId must be a non-empty string');
  }
  if (typeof context.userId !== 'string' || !context.userId.trim()) {
    errors.push('userId must be a non-empty string');
  }
  if (!Array.isArray(context.permissions)) {
    errors.push('permissions must be an array');
  }
  if (!Array.isArray(context.facts)) {
    errors.push('facts must be an array');
  } else {
    context.facts.forEach((fact, index) => {
      for (const error of validateFactRecord(fact)) {
        errors.push(`facts[${index}].${error}`);
      }
    });
  }
  if (!Array.isArray(context.warnings)) {
    errors.push('warnings must be an array');
  }
  if (!isPlainObject(context.metadata)) {
    errors.push('metadata must be an object');
  }
  return errors;
}

function assertValidAIContext(context) {
  const errors = validateAIContext(context);
  if (errors.length) {
    throw new Error(`Invalid AIContext: ${errors.join('; ')}`);
  }
  return context;
}

module.exports = {
  FACT_TYPES,
  AI_DOMAINS,
  FINDING_SEVERITIES,
  PROPOSAL_STATUSES,
  RECOMMENDATION_TYPES,
  validateFactRecord,
  assertValidFactRecord,
  validateAIContext,
  assertValidAIContext,
};

