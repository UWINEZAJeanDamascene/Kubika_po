ALTER TABLE "projects"
  ADD COLUMN "purpose" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "project_category" TEXT NOT NULL DEFAULT 'internal',
  ADD COLUMN "sponsor_id" CHAR(24),
  ADD COLUMN "team_member_ids" CHAR(24)[] NOT NULL DEFAULT ARRAY[]::CHAR(24)[],
  ADD COLUMN "currency_code" VARCHAR(3) NOT NULL DEFAULT 'RWF',
  ADD COLUMN "tax_rate_id" CHAR(24),
  ADD COLUMN "tax_rate_pct" DECIMAL(9,4) NOT NULL DEFAULT 0,
  ADD COLUMN "tax_inclusive" BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN "scope" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "exclusions" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "assumptions" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "constraints" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "is_template" BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX "projects_company_id_project_category_idx"
  ON "projects"("company_id", "project_category");
CREATE INDEX "projects_company_id_is_template_idx"
  ON "projects"("company_id", "is_template");

ALTER TABLE "projects"
  ADD CONSTRAINT "projects_tax_rate_id_fkey"
  FOREIGN KEY ("tax_rate_id") REFERENCES "tax_rates"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "project_type_settings" (
  "id" CHAR(24) NOT NULL,
  "company_id" CHAR(24) NOT NULL,
  "project_category" TEXT NOT NULL,
  "required_fields" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "updated_by" CHAR(24),
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "project_type_settings_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "project_type_settings_company_id_project_category_key"
  ON "project_type_settings"("company_id", "project_category");
CREATE INDEX "project_type_settings_company_id_idx"
  ON "project_type_settings"("company_id");

ALTER TABLE "project_type_settings"
  ADD CONSTRAINT "project_type_settings_company_id_fkey"
  FOREIGN KEY ("company_id") REFERENCES "companies"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- Preserve existing project access while moving authorization from budgets to projects.
UPDATE "roles" AS role
SET "permissions" = role."permissions" || COALESCE((
  SELECT jsonb_agg(jsonb_build_object('resource', 'projects', 'actions', permission->'actions'))
  FROM jsonb_array_elements(
    CASE WHEN jsonb_typeof(role."permissions") = 'array' THEN role."permissions" ELSE '[]'::jsonb END
  ) AS permissions(permission)
  WHERE permission->>'resource' = 'budgets'
), '[]'::jsonb)
WHERE jsonb_typeof(role."permissions") = 'array'
  AND NOT EXISTS (
    SELECT 1
    FROM jsonb_array_elements(role."permissions") AS permissions(permission)
    WHERE permission->>'resource' = 'projects'
  );
