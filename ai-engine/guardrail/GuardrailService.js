'use strict';

const { FACT_TYPES } = require('../shared/interfaces');

const GUARDRAIL_VERSION = 'guardrail-v2';

const ACTION_CLAIM_PATTERNS = [
  /\b(i|we|stacy)\s+(have\s+)?(created|posted|submitted|approved|deleted|voided|cancelled|sent|filed|paid|executed)\b/i,
  /\b(invoice|purchase order|payment|journal entry|stock adjustment|payroll run|tax return)\s+(has been|was)\s+(created|posted|submitted|approved|deleted|voided|cancelled|sent|filed|paid|executed)\b/i,
  /\b(i|we|stacy)\s+(have\s+)?(now\s+)?(posted|submitted|approved|deleted|voided|cancelled|sent|filed|paid)\b/i,
];

const SENSITIVE_KEYS = /^(password|passwd|secret|token|accessToken|refreshToken|apiKey|ssn|socialSecurityNumber|privateKey|email|phone|mobile|telephone|national[_-]?id|tax[_-]?id|tin|passport(?:Number)?|dateOfBirth|dob|homeAddress|personalAddress|bankAccount(?:Number)?)$/i;
const EMAIL_ADDRESS = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i;

function numericValues(value, output = new Set()) {
  if (typeof value === 'number' && Number.isFinite(value)) output.add(String(value));
  else if (typeof value === 'string') {
    for (const match of value.matchAll(/(?:^|[^\w])(-?\d+(?:,\d{3})*(?:\.\d+)?)(?:%|\b)/g)) {
      const number = Number(match[1].replace(/,/g, ''));
      if (Number.isFinite(number)) output.add(String(number));
    }
  } else if (Array.isArray(value)) value.forEach((item) => numericValues(item, output));
  else if (value && typeof value === 'object') Object.values(value).forEach((item) => numericValues(item, output));
  return output;
}

function responseNumbers(text) {
  const values = [];
  for (const match of String(text || '').matchAll(/(?:^|[^\w])(-?\d+(?:,\d{3})*(?:\.\d+)?)(?:%|\b)/g)) {
    const number = Number(match[1].replace(/,/g, ''));
    if (Number.isFinite(number)) values.push(String(number));
  }
  return values;
}

function factNumericValues(fact, output = new Set()) {
  numericValues([fact && fact.value, fact && fact.unit, fact && fact.formula, fact && fact.metadata], output);
  if (fact && typeof fact.value === 'number' && /%|percent/i.test(String(fact.unit || ''))) {
    output.add(String(fact.value * 100));
  }
  return output;
}

function inspectSensitiveKeys(value, path = '$', errors = []) {
  if (!value || typeof value !== 'object') return errors;
  for (const [key, child] of Object.entries(value)) {
    if (SENSITIVE_KEYS.test(key)) errors.push(`Sensitive field '${path}.${key}' is not allowed in the response`);
    inspectSensitiveKeys(child, `${path}.${key}`, errors);
  }
  return errors;
}

function factIdSet(facts = [], expectedCompanyId) {
  return new Set((facts || [])
    .filter((fact) => expectedCompanyId == null || String(fact.companyId) === String(expectedCompanyId))
    .map((fact) => fact && fact.id)
    .filter(Boolean));
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

function validateStructuredResponse(response, facts = [], { expectedCompanyId } = {}) {
  const errors = [];
  const warnings = [];
  const availableFactIds = factIdSet(facts, expectedCompanyId);
  if (expectedCompanyId != null && (facts || []).some((fact) => String(fact.companyId) !== String(expectedCompanyId))) {
    errors.push('Evidence contains facts from a different company');
  }

  if (!response || typeof response !== 'object' || Array.isArray(response)) {
    return { ok: false, errors: ['Response must be a JSON object.'], warnings };
  }

  inspectSensitiveKeys(response, '$', errors);
  if (expectedCompanyId != null) {
    const expected = String(expectedCompanyId);
    const inspectCompanyIds = (value) => {
      if (!value || typeof value !== 'object') return;
      for (const [key, child] of Object.entries(value)) {
        if (/^(companyId|tenantId)$/i.test(key) && String(child) !== expected) {
          errors.push(`Response ${key} does not match the active company`);
        } else inspectCompanyIds(child);
      }
    };
    inspectCompanyIds(response);
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
      if (typeof claim.text === 'string' && !response.answer.toLowerCase().includes(claim.text.trim().toLowerCase())) {
        errors.push(`claimLabels[${index}].text is not present in answer`);
      }
    });
  }

  if (!Array.isArray(response.missingData)) {
    errors.push('missingData must be an array');
  } else if (response.missingData.some((item) => typeof item !== 'string')) {
    errors.push('missingData entries must be strings');
  }

  if (!Array.isArray(response.recommendedActions)) {
    errors.push('recommendedActions must be an array');
  } else if (response.recommendedActions.some((item) => typeof item !== 'string')) {
    errors.push('recommendedActions entries must be strings');
  }

  const allText = [response.answer, ...(response.claimLabels || []).map((claim) => claim && claim.text), ...(response.recommendedActions || []).filter((item) => typeof item === 'string')].join('\n');
  if (EMAIL_ADDRESS.test(allText)) errors.push('Response contains a personal email address');
  errors.push(...validateNoUnsafeActionClaims(allText));

  const availableValues = new Set();
  facts.forEach((fact) => factNumericValues(fact, availableValues));
  for (const number of responseNumbers(response.answer)) {
    const supportedByClaim = (response.claimLabels || []).some((claim) => {
      if (!claim || typeof claim.text !== 'string' || !responseNumbers(claim.text).includes(number)) return false;
      const citedValues = new Set();
      facts.filter((fact) => (claim.factIds || []).includes(fact.id)).forEach((fact) => factNumericValues(fact, citedValues));
      return citedValues.has(number);
    });
    if (!availableValues.has(number) || !supportedByClaim) errors.push(`Answer contains unsupported or uncited number '${number}'`);
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

function parseAndValidateStructuredText(rawText, facts = [], options = {}) {
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

  const validation = validateStructuredResponse(parsed, facts, options);
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
