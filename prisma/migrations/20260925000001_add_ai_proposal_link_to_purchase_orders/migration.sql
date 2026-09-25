ALTER TABLE "purchase_orders"
  ADD COLUMN "ai_proposal_id" TEXT;

CREATE UNIQUE INDEX "purchase_orders_company_ai_proposal_id_key"
  ON "purchase_orders"("company_id", "ai_proposal_id");
