function getLocalWorkflowGuide(message) {
  const text = String(message || '').toLowerCase();
  if (!/\binvoices?\b/.test(text) || !/\b(create|confirm|draft|issue|make)\b/.test(text)) return null;
  return [
    'To create and confirm a sales invoice:',
    '1. Open Sales → Invoices and choose New Invoice.',
    '2. Select the customer, set the invoice and due dates, add products or services with quantities, and save the invoice as a draft.',
    '3. Open the draft, check the customer, totals, tax, and line items, then choose Confirm. You need invoice approval permission; confirmation also checks stock for stockable products.',
    '4. After confirmation, use Record Payment to enter a full or partial receipt when the customer pays.',
    'If Confirm is blocked, check that the invoice has at least one line, the products are active, and enough stock is available.',
  ].join('\n');
}

module.exports = { getLocalWorkflowGuide };