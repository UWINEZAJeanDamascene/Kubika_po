CREATE TABLE "project_members" (
  "id" CHAR(24) NOT NULL, "company_id" CHAR(24) NOT NULL, "project_id" CHAR(24) NOT NULL, "user_id" CHAR(24) NOT NULL,
  "role" TEXT NOT NULL DEFAULT 'contributor', "is_active" BOOLEAN NOT NULL DEFAULT TRUE, "added_by_id" CHAR(24),
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updated_at" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "project_members_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "project_members_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "project_members_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "project_members_company_id_project_id_user_id_key" ON "project_members"("company_id", "project_id", "user_id");
CREATE INDEX "project_members_company_id_user_id_is_active_idx" ON "project_members"("company_id", "user_id", "is_active");
CREATE TABLE "project_comments" (
  "id" CHAR(24) NOT NULL, "company_id" CHAR(24) NOT NULL, "project_id" CHAR(24) NOT NULL, "author_id" CHAR(24) NOT NULL,
  "author_name" TEXT NOT NULL, "body" TEXT NOT NULL, "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updated_at" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "project_comments_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "project_comments_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "project_comments_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "project_comments_company_id_project_id_created_at_idx" ON "project_comments"("company_id", "project_id", "created_at");
CREATE TABLE "project_activity" (
  "id" CHAR(24) NOT NULL, "company_id" CHAR(24) NOT NULL, "project_id" CHAR(24) NOT NULL, "actor_id" CHAR(24),
  "actor_name" TEXT NOT NULL, "event_type" TEXT NOT NULL, "message" TEXT NOT NULL, "metadata" JSONB NOT NULL DEFAULT '{}', "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "project_activity_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "project_activity_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "project_activity_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "project_activity_company_id_project_id_created_at_idx" ON "project_activity"("company_id", "project_id", "created_at");
CREATE TABLE "project_documents" (
  "id" CHAR(24) NOT NULL, "company_id" CHAR(24) NOT NULL, "project_id" CHAR(24) NOT NULL, "uploaded_by_id" CHAR(24) NOT NULL,
  "file_name" TEXT NOT NULL, "mime_type" TEXT NOT NULL, "file_size" INTEGER NOT NULL, "content" BYTEA NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "project_documents_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "project_documents_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "project_documents_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "project_documents_company_id_project_id_created_at_idx" ON "project_documents"("company_id", "project_id", "created_at");