'use strict';

const { FACT_TYPES } = require('../shared/interfaces');

const GUARDRAIL_VERSION = 'guardrail-v1';

const ACTION_CLAIM_PATTERNS = [
  /\b(i|we|stacy)\s+(created|posted|submitted|approved|deleted|voided|cancelled|sent|filed|paid|executed)\b/i,
  /\b(invoice|purchase order|payment|journal entry|stock adjustment|payroll run|tax return)\s+(has been|was)\s+(created|posted|submitted|approved|deleted|voided|cancelled|sent|filed|paid|executed)\b/i,
];

function factIdSet(facts = []) {
  return new Set((facts || []).map((fact) => fact && fact.id).filter(Boolean));
}

function extractJsonObject(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;

  try {
    return JSON.parse(trimmed);
  } catch {
    // Try fenced JSON.
  }

  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) {
    try {
      return JSON.parse(fence[1].trim());
    } catch {
      return null;
    }
  }

  return null;
}

function validateStructuredResponse(response, facts = []) {
  const errors = [];
  const warnings = [];
  const availableFactIds = factIdSet(facts);

  if (!response || typeof response !== 'object' || Array.isArray(response)) {
    return { ok: false, errors: ['Response must be a JSON object.'], warnings };
  }

  if (typeof response.answer !== 'string' || !response.answer.trim()) {
    errors.push('answer must be a non-empty string');
  }

  if (!Array.isArray(response.claimLabels)) {
    errors.push('claimLabels must be an array');
  } else {
    response.claimLabels.forEach((claim, index) => {
      if (!claim || typeof claim !== 'object') {
        errors.push(`claimLabels[${index}] must be an object`);
        return;
      }
      if (typeof claim.text !== 'string' || !claim.text.trim()) {
        errors.push(`claimLabels[${index}].text must be a non-empty string`);
      }
      if (!Object.values(FACT_TYPES).includes(claim.type)) {
        errors.push(`claimLabels[${index}].type is invalid`);
      }
      if (!Array.isArray(claim.factIds)) {
        errors.push(`claimLabels[${index}].factIds must be an array`);
      }
      if (claim.type === FACT_TYPES.FACT && (!Array.isArray(claim.factIds) || claim.factIds.length === 0)) {
        errors.push(`claimLabels[${index}] is FACT but has no factIds`);
      }
      for (const factId of claim.factIds || []) {
        if (!availableFactIds.has(factId)) {
          errors.push(`claimLabels[${index}] references unknown factId '${factId}'`);
        }
      }
    });
  }

  if (!Array.isArray(response.missingData)) {
    errors.push('missingData must be an array');
  }

  if (!Array.isArray(response.recommendedActions)) {
    errors.push('recommendedActions must be an array');
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
  };
}

function validateNoUnsafeActionClaims(text, { approvedActionIds = [] } = {}) {
  const errors = [];
  const approved = Array.isArray(approvedActionIds) && approvedActionIds.length > 0;
  if (!approved) {
    for (const pattern of ACTION_CLAIM_PATTERNS) {
      if (pattern.test(text || '')) {
        errors.push('Response appears to claim a consequential business action was already executed.');
        break;
      }
    }
  }
  return errors;
}

function validateFreeTextResponse(text, options = {}) {
  const errors = validateNoUnsafeActionClaims(text, options);
  return {
    ok: errors.length === 0,
    errors,
    warnings: [],
    version: GUARDRAIL_VERSION,
  };
}

function parseAndValidateStructuredText(rawText, facts = []) {
  const parsed = extractJsonObject(rawText);
  if (!parsed) {
    return {
      ok: false,
      parsed: null,
      errors: ['No valid JSON response object found.'],
      warnings: [],
      version: GUARDRAIL_VERSION,
    };
  }

  const validation = validateStructuredResponse(parsed, facts);
  return {
    ...validation,
    parsed,
    version: GUARDRAIL_VERSION,
  };
}

function guardedFallback(errors) {
  return [
    'I cannot safely complete that answer yet.',
    'The response failed the AI safety checks, so I am not going to present it as business fact.',
    `Issue: ${(errors || []).join('; ') || 'unsupported response'}`,
  ].join('\n');
}

module.exports = {
  GUARDRAIL_VERSION,
  extractJsonObject,
  validateStructuredResponse,
  validateFreeTextResponse,
  parseAndValidateStructuredText,
  guardedFallback,
};

