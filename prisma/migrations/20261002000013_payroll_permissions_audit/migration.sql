CREATE TABLE "payroll_audit_events" (
  "id" CHAR(24) NOT NULL,
  "company_id" CHAR(24) NOT NULL,
  "actor_user_id" CHAR(24),
  "action" TEXT NOT NULL,
  "entity_type" TEXT NOT NULL,
  "entity_id" TEXT NOT NULL,
  "changes" JSONB NOT NULL DEFAULT '{}'::jsonb,
  "ip_address" TEXT,
  "user_agent" TEXT,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "payroll_audit_events_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "payroll_runs" ADD COLUMN "created_by" CHAR(24);

CREATE INDEX "payroll_audit_events_company_entity_created_idx"
ON "payroll_audit_events" ("company_id", "entity_type", "entity_id", "created_at" DESC);

CREATE INDEX "payroll_audit_events_company_actor_created_idx"
ON "payroll_audit_events" ("company_id", "actor_user_id", "created_at" DESC);

CREATE FUNCTION prevent_payroll_audit_event_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'Payroll audit events are immutable';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "payroll_audit_events_immutable"
BEFORE UPDATE OR DELETE ON "payroll_audit_events"
FOR EACH ROW EXECUTE FUNCTION prevent_payroll_audit_event_mutation();
