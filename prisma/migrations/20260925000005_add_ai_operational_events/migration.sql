CREATE TABLE "ai_operational_events" (
    "id" CHAR(24) NOT NULL,
    "event_type" TEXT NOT NULL,
    "company_id" CHAR(24),
    "occurred_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "duration_ms" INTEGER,
    "provider" TEXT,
    "outcome" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}'::jsonb,

    CONSTRAINT "ai_operational_events_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ai_operational_events_event_type_occurred_at_idx"
    ON "ai_operational_events"("event_type", "occurred_at" DESC);
CREATE INDEX "ai_operational_events_company_id_event_type_occurred_at_idx"
    ON "ai_operational_events"("company_id", "event_type", "occurred_at" DESC);
