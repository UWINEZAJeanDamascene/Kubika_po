CREATE TABLE "testimonials" (
  "id" CHAR(24) NOT NULL,
  "name" TEXT NOT NULL,
  "role" TEXT NOT NULL,
  "company" TEXT NOT NULL,
  "avatar" TEXT,
  "content" TEXT NOT NULL,
  "rating" DOUBLE PRECISION NOT NULL DEFAULT 5,
  "is_active" BOOLEAN NOT NULL DEFAULT true,
  "order" INTEGER NOT NULL DEFAULT 0,
  "created_by" CHAR(24),
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "testimonials_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "testimonials_order_idx" ON "testimonials"("order");
CREATE INDEX "testimonials_is_active_idx" ON "testimonials"("is_active");
