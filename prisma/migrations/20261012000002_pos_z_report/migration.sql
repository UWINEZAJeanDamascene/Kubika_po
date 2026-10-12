ALTER TABLE invoices
  ADD COLUMN IF NOT EXISTS till_session_id CHAR(24),
  ADD COLUMN IF NOT EXISTS register_id TEXT;

CREATE INDEX IF NOT EXISTS invoices_company_till_session_invoice_date_idx
  ON invoices (company_id, till_session_id, invoice_date DESC);

ALTER TABLE till_sessions
  ADD COLUMN IF NOT EXISTS z_report JSONB,
  ADD COLUMN IF NOT EXISTS z_report_generated_at TIMESTAMPTZ(3);
