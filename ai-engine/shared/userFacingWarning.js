'use strict';

const TECHNICAL_WARNING = /(\bprisma\b|invalid `|invocation|sqlstate|\bselect\b.+\bfrom\b|query engine|stack trace|\bECONN[A-Z]+\b|\bTypeError\b|\bReferenceError\b|collector.{0,30}(failed|skipped)|\b(error|exception):)/i;

function userFacingWarning(value) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  if (!TECHNICAL_WARNING.test(text)) return text;

  const domain = /inventory|stock|product/i.test(text) ? 'inventory'
    : /finance|cash|bank|account/i.test(text) ? 'financial'
      : /receivable|customer|invoice/i.test(text) ? 'receivables'
        : /payable|purchase|supplier/i.test(text) ? 'purchasing'
          : /tax|vat/i.test(text) ? 'tax'
            : /sales|revenue/i.test(text) ? 'sales'
              : 'business';
  return `Some ${domain} data could not be loaded, so this result may be incomplete. Please try again later or contact support if the issue continues.`;
}

module.exports = { userFacingWarning };
