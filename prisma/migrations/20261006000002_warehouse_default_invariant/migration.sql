-- Remove invalid inactive defaults, then repair duplicate defaults before adding the invariant.
UPDATE warehouses
SET is_default = FALSE,
    updated_at = NOW()
WHERE is_default = TRUE
  AND is_active = FALSE;

WITH ranked_defaults AS (
  SELECT id,
         ROW_NUMBER() OVER (PARTITION BY company_id ORDER BY created_at ASC, id ASC) AS position
  FROM warehouses
  WHERE is_default = TRUE
)
UPDATE warehouses AS warehouse
SET is_default = FALSE,
    updated_at = NOW()
FROM ranked_defaults
WHERE warehouse.id = ranked_defaults.id
  AND ranked_defaults.position > 1;

CREATE UNIQUE INDEX IF NOT EXISTS warehouses_one_default_per_company_idx
  ON warehouses (company_id)
  WHERE is_default = TRUE;
