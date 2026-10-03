UPDATE "roles"
SET "permissions" = COALESCE("permissions", '[]'::jsonb) ||
  '[{"resource":"sales_invoices","actions":["delete"]},{"resource":"credit_notes","actions":["read","create","update","delete","approve"]}]'::jsonb,
  "updated_at" = CURRENT_TIMESTAMP
WHERE "name" = 'manager' AND "is_system_role" = TRUE;

UPDATE "roles"
SET "permissions" = COALESCE("permissions", '[]'::jsonb) ||
  '[{"resource":"credit_notes","actions":["read","create","update","delete"]}]'::jsonb,
  "updated_at" = CURRENT_TIMESTAMP
WHERE "name" = 'sales' AND "is_system_role" = TRUE;
