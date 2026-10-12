ALTER TABLE "invoice_lines"
  ADD COLUMN "project_id" CHAR(24);

CREATE INDEX "invoice_lines_company_id_project_id_idx"
  ON "invoice_lines"("company_id", "project_id");

ALTER TABLE "invoice_lines"
  ADD CONSTRAINT "invoice_lines_project_id_fkey"
  FOREIGN KEY ("project_id") REFERENCES "projects"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;