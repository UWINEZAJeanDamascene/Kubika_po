# Phase 1 status — Tenancy & Auth on PostgreSQL (Prisma)

Phase 1 is code-complete. The auth/tenancy domain (User, Company, Role,
UserRole, CompanyUser, RefreshToken, UserSession) runs **only** on PostgreSQL.
There is no Mongo fallback and no feature flag: `DATABASE_URL` is required and
the server refuses to boot without it. MongoDB remains only for the
not-yet-migrated domains (inventory, sales, purchases, finance, ...).

## Architecture

- `prisma/schema.prisma` — Phase 1 models; legacy Mongo ObjectId strings kept
  as `CHAR(24)` primary keys so API `_id` values never change.
- `lib/prisma.js` — singleton client; connected first in `server.js`,
  disconnected on shutdown.
- `utils/authMappers.js` — maps Prisma rows to the legacy Mongoose JSON shapes
  (`_id`, snake_case company fields) the frontend already consumes.
- `models/User.js`, `models/Company.js`, `models/Role.js` — **Prisma-backed
  shims** exposing the Mongoose query surface (`find`, `findById`, `findOne`,
  `countDocuments`, `create`, `updateOne/Many`, `deleteOne/Many`, chainables,
  `$in/$or/$ne/...` operators) via `utils/prismaCompat.js`. Unmigrated code
  keeps working untouched.
- `plugins/postgresRefPlugin.js` — global Mongoose plugin. Any
  `.populate('createdBy' | 'user' | 'company' | ...)` on a Mongo document whose
  ref is User/Company/Role is intercepted and hydrated from PostgreSQL
  (~160 call sites covered without edits).
- Tenant isolation: the User shim auto-injects `companyId` from the request's
  AsyncLocalStorage context (`utils/prismaTenant.js`), mirroring
  `plugins/tenantPlugin.js` — including `findById` visibility,
  `.setOptions({ skipTenant: true })` opt-out, and no injection outside a
  request context (scripts/ETL). Covered by unit tests. Postgres Row Level
  Security is deliberately deferred: enabling it on `users` would break
  login-by-email (no tenant known yet) without carefully designed policies —
  revisit when high-volume tenant tables (invoices, journal entries) migrate.
- Core services rewritten on Prisma directly: `UserService`, `CompanyService`,
  `tokenService`, `authDataService`, `userSessionActivity`, middleware
  (`auth`, `authorize`, `accessControl`), controllers (`auth`, `user`,
  `userAuth`, `role`, `company`, `security`), seed scripts.
- Mongo aggregations that `$lookup`ed the `users` collection
  (`auditTrailController`, `reportGeneratorService`) now enrich results from
  PostgreSQL after the pipeline.

## Rollout steps (all executed locally on 2026-07-25)

Local dev uses the Windows PostgreSQL 18 service (`postgresql-x64-18`, port
5432) — no Docker required. The `stock` role and `stock_management` database
were created to match the documented `DATABASE_URL`. Production can use the
docker-compose `postgres` service or any hosted Postgres.

1. `.env` has `DATABASE_URL=postgresql://stock:stock@localhost:5432/stock_management?schema=public`
2. `npm run db:generate` — Prisma client (pinned to v6)
3. `npx prisma migrate deploy` — Phase 1 tables created
4. `npm run etl:phase1` — Mongo (Atlas) auth data copied: 1 company, 2 users,
   9 system roles, ids preserved (`scripts/etl/verify-phase1.js` checks parity)
5. Server boot + smoke tests passed against Postgres
6. `npm run test:phase1` — 15/15 tests pass

## Verification checklist — DONE

- [x] `npx prisma validate` + `npx prisma generate`
- [x] `npx prisma migrate deploy` (note: migration.sql had a UTF-8 BOM that
      Postgres rejects — stripped; keep migration files BOM-free)
- [x] `npm run etl:phase1:dry` then `npm run etl:phase1`
- [x] Data parity verified in Postgres (counts, ids, enums, Decimal)
- [x] Server boot: Prisma + Mongo connected, no startup errors
- [x] `POST /api/auth/login` — tokens issued, memberships correct
- [x] `POST /api/auth/refresh` — rotation works
- [x] `GET /api/auth/me` — exact legacy shape (`_id`, snake_case fields,
      `permissions: ["*"]`), lastLogin updated in Postgres
- [x] `GET /api/companies` — legacy company shape incl. `billing_amount`
      as number (Decimal conversion verified live)
- [x] `npm run test:phase1` — 15/15

## Deferred to later phases

- Migrate remaining domains (products, invoices, journal entries, ...) —
  at that point the `postgresRefPlugin` and the compat shims can be deleted
  and callers moved to native Prisma queries.
- Integration tests against a disposable Postgres (Testcontainers).
- Decommission MongoDB entirely once all domains are migrated.
