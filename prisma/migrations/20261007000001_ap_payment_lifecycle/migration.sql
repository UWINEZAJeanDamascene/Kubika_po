-- Add auditable supplier payment lifecycle details.
ALTER TABLE ap_payments
  ADD COLUMN IF NOT EXISTS external_reference TEXT,
  ADD COLUMN IF NOT EXISTS notes TEXT,
  ADD COLUMN IF NOT EXISTS posted_by CHAR(24),
  ADD COLUMN IF NOT EXISTS posted_at TIMESTAMPTZ(3),
  ADD COLUMN IF NOT EXISTS reversed_by CHAR(24),
  ADD COLUMN IF NOT EXISTS reversed_at TIMESTAMPTZ(3),
  ADD COLUMN IF NOT EXISTS reversal_reason TEXT;
