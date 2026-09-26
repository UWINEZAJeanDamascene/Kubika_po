-- Backfill company membership rows for primary users linked through users.company_id.
-- Preserve explicitly suspended/inactive memberships by inserting only missing pairs.
INSERT INTO "company_users" (
    "id", "user_id", "company_id", "role", "permissions", "status",
    "preferences", "created_at", "updated_at"
)
SELECT
    SUBSTRING(MD5(users."id" || ':' || users."company_id"), 1, 24),
    users."id",
    users."company_id",
    users."role",
    '[]'::jsonb,
    'active'::"CompanyUserStatus",
    '{}'::jsonb,
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
FROM "users" AS users
WHERE users."company_id" IS NOT NULL
  AND users."is_active" = TRUE
  AND EXISTS (SELECT 1 FROM "companies" WHERE "companies"."id" = users."company_id")
ON CONFLICT ("user_id", "company_id") DO NOTHING;