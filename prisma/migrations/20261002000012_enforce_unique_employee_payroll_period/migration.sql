DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "payrolls"
    WHERE COALESCE(NULLIF(BTRIM("employee_id"::text), ''), NULLIF(BTRIM("employee"->>'employeeId'), '')) IS NULL
       OR COALESCE(
         CASE
           WHEN ("period"->>'year') ~ '^[0-9]{4}$'
             AND ("period"->>'month') ~ '^(0?[1-9]|1[0-2])$'
           THEN make_date(("period"->>'year')::integer, ("period"->>'month')::integer, 1)
           ELSE NULL
         END,
         date_trunc('month', "pay_period_start" AT TIME ZONE 'UTC')::date
       ) IS NULL
  ) THEN
    RAISE EXCEPTION 'Cannot enforce unique payroll periods: payroll records are missing an employee identity or valid period. Correct those records before retrying this migration.';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "payrolls"
    WHERE LOWER(COALESCE(NULLIF(BTRIM("employee_id"::text), ''), NULLIF(BTRIM("employee"->>'employeeId'), ''))) IS NOT NULL
      AND COALESCE(
        CASE
          WHEN ("period"->>'year') ~ '^[0-9]{4}$'
            AND ("period"->>'month') ~ '^(0?[1-9]|1[0-2])$'
          THEN make_date(("period"->>'year')::integer, ("period"->>'month')::integer, 1)
          ELSE NULL
        END,
        date_trunc('month', "pay_period_start" AT TIME ZONE 'UTC')::date
      ) IS NOT NULL
    GROUP BY
      "company_id",
      LOWER(COALESCE(NULLIF(BTRIM("employee_id"::text), ''), NULLIF(BTRIM("employee"->>'employeeId'), ''))),
      COALESCE(
        CASE
          WHEN ("period"->>'year') ~ '^[0-9]{4}$'
            AND ("period"->>'month') ~ '^(0?[1-9]|1[0-2])$'
          THEN make_date(("period"->>'year')::integer, ("period"->>'month')::integer, 1)
          ELSE NULL
        END,
        date_trunc('month', "pay_period_start" AT TIME ZONE 'UTC')::date
      )
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'Cannot enforce unique payroll periods: duplicate employee payroll records exist. Resolve duplicates before retrying this migration.';
  END IF;
END $$;

CREATE UNIQUE INDEX "payrolls_company_employee_period_unique_idx"
ON "payrolls" (
  "company_id",
  (LOWER(COALESCE(NULLIF(BTRIM("employee_id"::text), ''), NULLIF(BTRIM("employee"->>'employeeId'), '')))),
  (COALESCE(
    CASE
      WHEN ("period"->>'year') ~ '^[0-9]{4}$'
        AND ("period"->>'month') ~ '^(0?[1-9]|1[0-2])$'
      THEN make_date(("period"->>'year')::integer, ("period"->>'month')::integer, 1)
      ELSE NULL
    END,
    date_trunc('month', "pay_period_start" AT TIME ZONE 'UTC')::date
  ))
);

ALTER TABLE "payrolls"
ADD CONSTRAINT "payrolls_employee_period_identity_check"
CHECK (
  COALESCE(NULLIF(BTRIM("employee_id"::text), ''), NULLIF(BTRIM("employee"->>'employeeId'), '')) IS NOT NULL
  AND COALESCE(
    CASE
      WHEN ("period"->>'year') ~ '^[0-9]{4}$'
        AND ("period"->>'month') ~ '^(0?[1-9]|1[0-2])$'
      THEN make_date(("period"->>'year')::integer, ("period"->>'month')::integer, 1)
      ELSE NULL
    END,
    date_trunc('month', "pay_period_start" AT TIME ZONE 'UTC')::date
  ) IS NOT NULL
);
