# MongoDB → PostgreSQL Migration Guide (Prisma)

**Project:** Stock Tenancy System (`Stock_tenancy_system`)  
**Target database:** PostgreSQL 16+  
**ORM:** Prisma 6.x (pinned — do not use Prisma 7 without adapter/config migration)  
**Goal:** Replace MongoDB/Mongoose with PostgreSQL/Prisma **without breaking the frontend** and **without changing public API routes or response shapes**.

---

## Table of contents

1. [Executive summary](#1-executive-summary)
2. [Current backend audit](#2-current-backend-audit)
3. [Migration principles (non‑negotiables)](#3-migration-principles-nonnegotiables)
4. [Target architecture](#4-target-architecture)
5. [Prerequisites & tooling](#5-prerequisites--tooling)
6. [Step 1 — Project setup (Prisma bootstrap)](#6-step-1--project-setup-prisma-bootstrap)
7. [Step 2 — Schema design conventions](#7-step-2--schema-design-conventions)
8. [Step 3 — MongoDB → PostgreSQL type mapping](#8-step-3--mongodb--postgresql-type-mapping)
9. [Step 4 — API compatibility layer](#9-step-4--api-compatibility-layer)
10. [Step 5 — Multi‑tenant isolation](#10-step-5--multitenant-isolation)
11. [Step 6 — Repository & service refactor pattern](#11-step-6--repository--service-refactor-pattern)
12. [Step 7 — Aggregation → SQL migration](#12-step-7--aggregation--sql-migration)
13. [Step 8 — Transactions & sequences](#13-step-8--transactions--sequences)
14. [Step 9 — Phased domain migration order](#14-step-9--phased-domain-migration-order)
15. [Step 10 — Data migration (ETL)](#15-step-10--data-migration-etl)
16. [Step 11 — Dual‑write / strangler cutover](#16-step-11--dualwrite--strangler-cutover)
17. [Step 12 — Environment & deployment](#17-step-12--environment--deployment)
18. [Step 13 — Testing strategy](#18-step-13--testing-strategy)
19. [Step 14 — Final cutover checklist](#19-step-14--final-cutover-checklist)
20. [Step 15 — Rollback plan](#20-step-15--rollback-plan)
21. [Appendix A — Full model inventory](#appendix-a--full-model-inventory)
22. [Appendix B — Route inventory (must stay unchanged)](#appendix-b--route-inventory-must-stay-unchanged)
23. [Appendix C — High‑risk areas](#appendix-c--highrisk-areas)
24. [Appendix D — Per‑phase file checklist](#appendix-d--perphase-file-checklist)

---

## 1. Executive summary

The backend today is a **Node.js / Express** monolith using **Mongoose 8** against **MongoDB**, with:

- **~131 Mongoose models** across ERP domains (inventory, sales, purchases, GL, AR/AP, payroll, budgets, EBM/RRA fiscal, reports, dashboards).
- **79 route modules** mounted at `/api` and `/api/v1` (identical router in `server.js`).
- **Global tenant plugin** (`plugins/tenantPlugin.js`) injecting `{ company: companyId }` on queries/aggregations.
- **Heavy use of aggregation pipelines** (~200+ call sites), **Decimal128** money fields, and **embedded line arrays** (invoices, journal entries, purchases).
- **No Prisma or PostgreSQL** in application code today.

The frontend (`Stock_tenancy_bnd`) depends on:

- Stable REST paths (e.g. `/api/dashboard/inventory`, `/api/sales-invoices`, `/api/ebm/...`).
- Mongo-style **`_id` string fields** on virtually every entity in `src/lib/api.ts`.
- Nested/embedded shapes (invoice lines, journal lines, EBM submission blocks).
- `{ success, data }` or raw payload patterns per endpoint (dashboard routes return raw service payloads).

**Recommended strategy:** **Strangler Fig migration** — introduce Prisma + PostgreSQL alongside MongoDB, migrate domain-by-domain behind unchanged controllers/routes, use a **response serializer** to preserve `_id` and field names, run **dual-write** during transition, then decommission MongoDB.

**Estimated effort:** 4–9 months for full migration (team-dependent), with first production-ready slice (auth + company + products) in 4–6 weeks.

---

## 2. Current backend audit

### 2.1 Entry point & boot sequence

| File | Role |
|------|------|
| `server.js` | Main entry — `connectDB()` → register tenant plugin → load all models → mount routes → schedulers |
| `config/database.js` | `mongoose.connect(MONGODB_URI)` |
| `src/config/environment.js` | Central env (`MONGODB_URI`, pool sizes, timeouts) |

Boot order matters for migration: anything that `require('./models/...')` side-effects Mongoose registration must be replaced gradually with Prisma client initialization (`lib/prisma.js`).

### 2.2 Database connection (today)

```env
MONGODB_URI=mongodb://localhost:27017/stock-management
MONGODB_MAX_POOL_SIZE=50
MONGODB_MIN_POOL_SIZE=0
MONGODB_SERVER_SELECTION_TIMEOUT_MS=30000
QUERY_TIMEOUT_MS=               # optional, used by aggregateWithTimeout
```

### 2.3 Models (summary)

| Domain | Approx. models | Notes |
|--------|----------------|-------|
| Auth / tenancy | 15 | `User`, `Company`, `Role`, `CompanyUser`, sessions, tokens |
| Inventory | 18 | `Product`, `StockLevel`, `StockMovement`, batches, serials |
| Sales / AR | 16 | `Invoice` (embedded lines), `Client`, `ARReceipt`, credit notes |
| Purchases / AP | 12 | `Purchase`, `PurchaseOrder`, GRN, AP payments |
| GL / accounting | 12 | `JournalEntry` (embedded + denormalized lines), COA, tax |
| Banking | 10 | `BankAccount` file registers 5 models |
| Budget / projects | 10 | `company_id` naming |
| HR / payroll | 8 | Employees, payroll runs |
| Fixed assets / loans | 8 | Decimal128 heavy |
| EBM / RRA VSDC | 12 | Devices, sync state, queues, sequences |
| Reports / misc | 10 | `PrecomputedAggregation`, import jobs |

**Tenant field inconsistency (must normalize in Postgres):**

- Most models: `company` (ObjectId)
- Some models: `company_id` (`Liability`, `StockMovement`, all `Budget*`, `JournalEntryLine`, `SystemSettings`)

### 2.4 Routes (unchanged in migration)

All routes are registered in `server.js` on shared `apiRouter`, mounted at **`/api`** and **`/api/v1`**.

See [Appendix B](#appendix-b--route-inventory-must-stay-unchanged) for the full list.

**Important:** Two dashboard routers coexist:

- `routes/dashboard.routes.js` — Phase 3 executive/inventory/sales/purchase/finance dashboards
- `routes/dashboardRoutes.js` — legacy stats

Both must continue to work during and after migration.

### 2.5 MongoDB-specific patterns in use

| Pattern | Location | Postgres equivalent |
|---------|----------|---------------------|
| `aggregateWithTimeout()` | `utils/mongoAggregation.js` | Prisma `$queryRaw` + `statement_timeout` |
| `$lookup` / `$unwind` / `$facet` | reports, dashboards | SQL JOINs, CTEs, window functions |
| `Decimal128` | ~35 models | `Decimal` / `@db.Decimal(19, 4)` |
| Embedded arrays (`lines[]`) | Invoice, JournalEntry, Purchase | Child tables (`invoice_lines`, etc.) |
| Dual storage | `JournalEntry.lines[]` + `JournalEntryLine` | Single normalized source in Postgres |
| Partial unique index | JournalEntry idempotency | `CREATE UNIQUE INDEX ... WHERE` |
| `Schema.Types.Mixed` | EBM init, report cache | `Json` / `@db.JsonB` |
| Global tenant plugin | `plugins/tenantPlugin.js` | Prisma middleware + RLS |
| `runInTransaction()` | `services/transactionService.js` | `prisma.$transaction()` |
| ObjectId generation | `_id` auto | See [ID strategy](#id-strategy) |

### 2.6 Middleware chain (preserve behavior)

| Middleware | File | Migration impact |
|------------|------|------------------|
| Tenant context (ALS) | `middleware/tenantContextMiddleware.js` | Keep — Prisma middleware reads same `companyId` |
| JWT auth | `middleware/auth.js` | Keep unchanged |
| RBAC | `middleware/authorize.js` | Keep — still loads Role from DB |
| Company header | `middleware/companyContext.js` | Keep |
| Redis cache / rate limit | `config/redis.js`, `middleware/redisRateLimiter.js` | Unaffected |

### 2.7 Tests (gap)

- 14 Jest test files; **most mock Mongoose models** (especially EBM tests).
- `mongodb-memory-server` is in devDependencies but **not wired**.
- CI runs tests **without a live MongoDB**.

**Action:** Migration must add PostgreSQL integration tests (Testcontainers or dedicated CI service).

---

## 3. Migration principles (non‑negotiables)

### 3.1 API contract freeze

For every endpoint:

1. **Same HTTP method, path, query params, and request body fields.**
2. **Same response JSON shape** — field names, nesting, arrays, nullability.
3. **Same HTTP status codes** for success and error cases.
4. **`_id` must remain** on all entities the frontend expects (map Postgres `id` → `_id` at the boundary).
5. **Dates** stay ISO-8601 strings where they are today.
6. **Decimals** stay JSON numbers (or strings where the frontend already expects strings — verify per endpoint).

### 3.2 No frontend changes in Phase 1

The React app (`Stock_tenancy_bnd`) must not require changes for the migration to succeed. All adaptation happens in:

- Controllers (thin)
- Serializers (`utils/apiSerializer.js`)
- Services / repositories (thick)

### 3.3 Single write source per domain

During transition each domain has exactly one **authoritative** database. Never read from Postgres and write to Mongo for the same domain after cutover.

### 3.4 Normalize tenant key

PostgreSQL schema uses **`company_id UUID NOT NULL`** on every tenant table. Migrate both `company` and `company_id` Mongo fields into this single column.

### ID strategy

The frontend uses Mongo ObjectId strings (`"507f1f77bcf86cd799439011"`) as `_id`.

**Recommended approach (zero frontend break):**

1. **Phase A (migration):** Store legacy IDs in `id CHAR(24) PRIMARY KEY` preserving original ObjectId hex strings.
2. **Phase B (optional later):** Add `uuid UUID DEFAULT gen_random_uuid()` for internal use; still serialize `_id` as the legacy 24-char string until a coordinated frontend migration.

Prisma schema example:

```prisma
model Company {
  id   String @id @db.Char(24) // legacy ObjectId
  name String
  // ...
}
```

Serializer:

```javascript
function toApi(doc) {
  if (!doc) return doc;
  const { id, ...rest } = doc;
  return { _id: id, ...rest };
}
```

---

## 4. Target architecture

```
┌─────────────────────────────────────────────────────────────┐
│  Express routes (UNCHANGED)     controllers (thin)          │
└────────────────────────────┬────────────────────────────────┘
                             │
┌────────────────────────────▼────────────────────────────────┐
│  apiSerializer.js  — _id mapping, Decimal, dates, nested   │
└────────────────────────────┬────────────────────────────────┘
                             │
┌────────────────────────────▼────────────────────────────────┐
│  services/*.js — business logic (refactored gradually)      │
└────────────────────────────┬────────────────────────────────┘
                             │
          ┌──────────────────┴──────────────────┐
          │                                     │
┌─────────▼─────────┐              ┌───────────▼───────────┐
│ repositories/     │              │ repositories/         │
│ prisma/*.repo.js  │              │ mongo/*.repo.js       │
│ (NEW, per domain) │              │ (legacy, removed      │
└─────────┬─────────┘              │  domain by domain)    │
          │                        └───────────┬───────────┘
┌─────────▼─────────┐                        │
│  PostgreSQL         │              ┌─────────▼─────────┐
│  (Prisma Client)    │              │  MongoDB           │
└─────────────────────┘              │  (Mongoose)        │
                                     └────────────────────┘
```

**New files to introduce:**

```
Stock_tenancy_system/
├── prisma/
│   ├── schema.prisma
│   ├── migrations/
│   └── seed.ts
├── lib/
│   └── prisma.js                 # singleton PrismaClient
├── repositories/
│   ├── prisma/
│   │   ├── company.repository.js
│   │   ├── product.repository.js
│   │   └── ...
│   └── index.js                  # factory: returns prisma or mongo repo by feature flag
├── utils/
│   ├── apiSerializer.js          # _id, Decimal, nested lines
│   └── prismaTenant.js           # inject company_id extension
└── scripts/
    ├── etl/
    │   ├── export-mongo.js
    │   ├── import-postgres.ts
    │   └── verify-parity.js
    └── cutover/
        └── domain-cutover.js
```

---

## 5. Prerequisites & tooling

### 5.1 Software

| Tool | Version | Purpose |
|------|---------|---------|
| PostgreSQL | 16+ | Primary database |
| Node.js | 24.x (matches frontend engines) | Runtime |
| Prisma CLI | 6.x | Schema, migrate, generate |
| Docker | latest | Local Postgres + optional Mongo for ETL |
| pgAdmin / DBeaver | — | Inspection |

### 5.2 Install Prisma (Step 0 command)

```bash
cd Stock_tenancy_system
npm install prisma @prisma/client --save
npm install -D prisma
npx prisma init --datasource-provider postgresql
```

### 5.3 Docker Compose for local Postgres

Add to `docker-compose.yml` (or create `docker-compose.postgres.yml`):

```yaml
services:
  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: stock
      POSTGRES_PASSWORD: stock
      POSTGRES_DB: stock_management
    ports:
      - "5432:5432"
    volumes:
      - pgdata:/var/lib/postgresql/data

volumes:
  pgdata:
```

### 5.4 Team skills

- SQL (JOINs, CTEs, window functions) for report/dashboard rewrites
- Prisma schema modeling (relations, enums, indexes)
- ETL scripting and data parity verification

---

## 6. Step 1 — Project setup (Prisma bootstrap)

### 6.1 Environment variables

Add to `.env` (keep `MONGODB_URI` during transition):

```env
# PostgreSQL (new)
DATABASE_URL=postgresql://stock:stock@localhost:5432/stock_management?schema=public

# Migration feature flags (new)
DB_BACKEND=hybrid                    # mongo | hybrid | postgres
PRISMA_LOG=warn                      # query | info | warn | error

# Existing Mongo — keep until final cutover
MONGODB_URI=mongodb://localhost:27017/stock-management
```

Update `src/config/environment.js`:

```javascript
db: {
  mongoUri: process.env.MONGODB_URI,
  postgresUrl: process.env.DATABASE_URL,
  backend: process.env.DB_BACKEND || 'mongo',
},
```

### 6.2 Prisma client singleton

Create `lib/prisma.js`:

```javascript
const { PrismaClient } = require('@prisma/client');

const globalForPrisma = globalThis;

const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: (process.env.PRISMA_LOG || 'warn').split(','),
  });

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma;

module.exports = { prisma };
```

### 6.3 Update `server.js` boot (additive, not breaking)

```javascript
// After connectDB() — add:
const { prisma } = require('./lib/prisma');
await prisma.$connect();
console.log('PostgreSQL connected via Prisma');

// Graceful shutdown — add:
await prisma.$disconnect();
```

Do **not** remove `connectDB()` until final cutover.

### 6.4 NPM scripts

Add to `package.json`:

```json
{
  "scripts": {
    "db:generate": "prisma generate",
    "db:migrate": "prisma migrate dev",
    "db:migrate:deploy": "prisma migrate deploy",
    "db:studio": "prisma studio",
    "db:seed": "node prisma/seed.js",
    "etl:export": "node scripts/etl/export-mongo.js",
    "etl:import": "node scripts/etl/import-postgres.js",
    "etl:verify": "node scripts/etl/verify-parity.js"
  }
}
```

---

## 7. Step 2 — Schema design conventions

### 7.1 Naming

| Layer | Convention | Example |
|-------|------------|---------|
| PostgreSQL table | `snake_case` plural | `journal_entries` |
| PostgreSQL column | `snake_case` | `company_id`, `created_at` |
| Prisma model | `PascalCase` singular | `JournalEntry` |
| Prisma field | `camelCase` | `companyId`, `createdAt` |
| API JSON | **unchanged** (camelCase/snake mix as today) | `_id`, `entryNumber`, `company_id` where used |

Use `@map` and `@@map` to decouple Prisma from SQL names:

```prisma
model Invoice {
  id            String   @id @db.Char(24)
  companyId     String   @map("company_id") @db.Char(24)
  referenceNo   String   @map("reference_no")
  createdAt     DateTime @default(now()) @map("created_at")

  lines         InvoiceLine[]

  @@map("invoices")
  @@index([companyId, createdAt])
}
```

### 7.2 Standard columns (every tenant table)

```prisma
  id         String   @id @db.Char(24)
  companyId  String   @map("company_id") @db.Char(24)
  createdAt  DateTime @default(now()) @map("created_at")
  updatedAt  DateTime @updatedAt @map("updated_at")
  isActive   Boolean  @default(true) @map("is_active")  // where soft-delete used
```

### 7.3 Normalize embedded arrays

Mongo embedded `lines[]` become child tables:

| Mongo parent | Embedded path | Postgres child table |
|--------------|---------------|----------------------|
| `Invoice` | `lines[]` | `invoice_lines` |
| `JournalEntry` | `lines[]` | `journal_entry_lines` (already partially exists) |
| `Purchase` | `lines[]` | `purchase_lines` |
| `SalesOrder` | `lines[]` | `sales_order_lines` |
| `Quotation` | `lines[]` | `quotation_lines` |
| `CreditNote` | `lines[]` | `credit_note_lines` |

**Rule:** Pick **one** source of truth in Postgres (child table). Drop dual embedded + denormalized pattern.

### 7.4 Money fields

```prisma
  unitPrice  Decimal @db.Decimal(19, 4)
  lineTotal  Decimal @db.Decimal(19, 4) @map("line_total")
```

Never use `Float` for money.

### 7.5 JSON / Mixed fields

```prisma
  initResult  Json?  @map("init_result") @db.JsonB   // EBMDevice
  metadata    Json?  @db.JsonB
```

### 7.6 Enums

Convert Mongoose `enum: [...]` to Prisma `enum` types:

```prisma
enum InvoiceStatus {
  draft
  confirmed
  partially_paid
  fully_paid
  cancelled
}
```

Serializer must still emit **exact string values** the frontend expects (verify each enum).

### 7.7 Indexes (port from Mongo)

| Mongo index | Postgres |
|-------------|----------|
| `{ company: 1, referenceNo: 1 }` unique | `@@unique([companyId, referenceNo])` |
| Partial unique on JournalEntry | `CREATE UNIQUE INDEX ... WHERE source_id IS NOT NULL` |
| Text search (if any) | `GIN` tsvector or pg_trgm |

---

## 8. Step 3 — MongoDB → PostgreSQL type mapping

| MongoDB / Mongoose | PostgreSQL | Prisma |
|--------------------|------------|--------|
| `ObjectId` | `CHAR(24)` or `UUID` | `String @db.Char(24)` |
| `String` | `TEXT` / `VARCHAR(n)` | `String` |
| `Number` | `INTEGER` / `DOUBLE PRECISION` | `Int` / `Float` |
| `Decimal128` | `NUMERIC(19,4)` | `Decimal @db.Decimal(19,4)` |
| `Date` | `TIMESTAMPTZ` | `DateTime` |
| `Boolean` | `BOOLEAN` | `Boolean` |
| `Mixed` / `Object` | `JSONB` | `Json` |
| `Array` of subdocs | child table | `@relation` one-to-many |
| `Array` of primitives | `TEXT[]` or join table | `String[]` |
| `_id` (auto) | explicit `id` PK | `@id` |
| `ref: 'Product'` | FK constraint | `@relation(fields: [productId], references: [id])` |

---

## 9. Step 4 — API compatibility layer

Create `utils/apiSerializer.js` — **mandatory** for every Prisma-backed endpoint.

### 9.1 Core serializer

```javascript
const { Decimal } = require('@prisma/client/runtime/library');

function serializeId(record) {
  if (!record) return record;
  const { id, ...rest } = record;
  return { _id: id, ...rest };
}

function serializeDecimal(value) {
  if (value instanceof Decimal) return Number(value.toString());
  return value;
}

function deepSerialize(obj) {
  if (obj === null || obj === undefined) return obj;
  if (obj instanceof Decimal) return serializeDecimal(obj);
  if (obj instanceof Date) return obj.toISOString();
  if (Array.isArray(obj)) return obj.map(deepSerialize);
  if (typeof obj === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
      if (k === 'id') out._id = v;
      else out[k] = deepSerialize(v);
    }
    return out;
  }
  return obj;
}

module.exports = { serializeId, deepSerialize };
```

### 9.2 Controller pattern (unchanged route, new service)

```javascript
// controllers/productController.js — AFTER migration
const productService = require('../services/productService');
const { deepSerialize } = require('../utils/apiSerializer');

exports.list = async (req, res, next) => {
  try {
    const products = await productService.list(req.companyId, req.query);
    res.json({ success: true, data: deepSerialize(products) });
  } catch (err) {
    next(err);
  }
};
```

### 9.3 Response parity tests

For each migrated endpoint, add a snapshot test comparing Mongo vs Postgres responses for the same fixture data (field names, types, array lengths).

### 9.4 Populate / ref field names

Mongoose `.populate('product')` returns nested objects with `_id`. Prisma `include: { product: true }` returns nested `id`. Always run `deepSerialize()` on the full tree.

### 9.5 Virtuals and aliases

Mongo models use virtuals (e.g. Invoice line `quantity` alias for `qty`). Replicate in serializer:

```javascript
if (line.qty !== undefined && line.quantity === undefined) {
  line.quantity = line.qty;
}
```

Document every virtual/alias in a `API_ALIASES.md` checklist during each domain migration.

---

## 10. Step 5 — Multi‑tenant isolation

### 10.1 Current behavior

`plugins/tenantPlugin.js` auto-adds `{ company: companyId }` from AsyncLocalStorage set by `tenantContextMiddleware.js`.

### 10.2 Prisma equivalent (application layer)

Create `utils/prismaTenant.js`:

```javascript
const { prisma } = require('../lib/prisma');
const tenantContext = require('../lib/tenantContext');

function getCompanyId() {
  const store = tenantContext.getStore();
  return store?.companyId ?? null;
}

function tenantPrisma() {
  const companyId = getCompanyId();
  return prisma.$extends({
    query: {
      $allModels: {
        async findMany({ model, args, query }) {
          if (companyId && args.skipTenant !== true) {
            args.where = { ...args.where, companyId };
          }
          return query(args);
        },
        // repeat for findFirst, update, delete, count, etc.
      },
    },
  });
}

module.exports = { tenantPrisma, getCompanyId };
```

### 10.3 PostgreSQL Row Level Security (recommended for production)

After schema migration:

```sql
ALTER TABLE invoices ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON invoices
  USING (company_id = current_setting('app.company_id', true));
```

Set per request in Prisma middleware:

```javascript
await prisma.$executeRaw`SELECT set_config('app.company_id', ${companyId}, true)`;
```

### 10.4 Platform admin bypass

Preserve `req.isPlatformAdmin` behavior from `middleware/auth.js` — platform routes use `skipTenant: true` equivalent and explicit filters.

---

## 11. Step 6 — Repository & service refactor pattern

> **Phase 1 outcome (auth/tenancy):** this pattern was built, then deliberately
> replaced. Because the decision was made to run auth **only** on PostgreSQL
> (no `DB_BACKEND` flag, no dual backend), the repository interfaces + factory
> added indirection with nothing to switch between. What shipped instead:
>
> - Core services (`UserService`, `CompanyService`, `tokenService`,
>   `authDataService`) call Prisma directly.
> - The 11.3 goal — *controllers and routes do not change* — is met by
>   `utils/authMappers.js` (legacy response shapes) and the Mongoose-compatible
>   shims in `models/User.js` / `Company.js` / `Role.js` (legacy query surface,
>   incl. tenant auto-scoping) for the ~50 unmigrated consumer files.
> - The 11.4 decommission checklist is complete for this domain: mongo
>   repositories deleted, `RefreshToken`/`UserSession` model requires removed
>   from `server.js`, and the ETL is a one-way idempotent sync (no dual-write).
>
> For **later phases**, reuse this decision: skip the repository layer and port
> each domain service directly to Prisma behind the existing service interface,
> unless a domain genuinely needs a gradual mongo/postgres switchover.

### 11.1 Repository interface (per aggregate)

```javascript
// repositories/interfaces/product.repository.interface.js
/**
 * @typedef {object} ProductRepository
 * @property {(companyId: string, filters: object) => Promise<Product[]>} findMany
 * @property {(companyId: string, id: string) => Promise<Product|null>} findById
 * @property {(companyId: string, data: object) => Promise<Product>} create
 * @property {(companyId: string, id: string, data: object) => Promise<Product>} update
 */
```

### 11.2 Factory with feature flag

```javascript
// repositories/index.js
const config = require('../src/config/environment').getConfig();

function getProductRepository() {
  if (config.db.backend === 'postgres') {
    return require('./prisma/product.repository');
  }
  return require('./mongo/product.repository'); // thin Mongoose wrapper
}

module.exports = { getProductRepository };
```

### 11.3 Service refactor (minimal change)

```javascript
// services/productService.js — BEFORE
const Product = require('../models/Product');
exports.list = (companyId, filters) => Product.find({ ...filters });

// services/productService.js — AFTER
const { getProductRepository } = require('../repositories');
const repo = getProductRepository();
exports.list = (companyId, filters) => repo.findMany(companyId, filters);
```

**Controllers and routes do not change.**

### 11.4 Decommission rule

When a domain is fully migrated and verified:

1. Delete `repositories/mongo/<domain>.repository.js`
2. Remove Mongoose model `require()` from `server.js` for that model (last step only)
3. Remove domain from ETL dual-write

---

## 12. Step 7 — Aggregation → SQL migration

### 12.1 Wrapper replacement

Replace `utils/mongoAggregation.js`:

```javascript
// utils/sqlQuery.js
const { prisma } = require('../lib/prisma');

async function queryWithTimeout(sql, params, timeoutMs = 5000) {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL statement_timeout = ${timeoutMs}`);
    return tx.$queryRawUnsafe(sql, ...params);
  });
}

module.exports = { queryWithTimeout };
```

### 12.2 Dashboard services (Phase 3)

Files to rewrite:

| File | Mongo pattern | SQL approach |
|------|---------------|--------------|
| `services/dashboards/ExecutiveDashboardService.js` | `$match` + iterate journal lines | CTE on `journal_entry_lines` joined to `chart_of_accounts` |
| `services/dashboards/InventoryDashboardService.js` | `$lookup` stock | JOIN `stock_levels`, `products`, `warehouses` |
| `services/dashboards/SalesDashboardService.js` | Invoice aggregation | GROUP BY on `invoices`, `ar_*` tables |
| `services/dashboards/PurchaseDashboardService.js` | PO/GRN aggregation | JOIN purchase tables |
| `services/dashboards/FinanceDashboardService.js` | Bank + budget aggregation | JOIN bank accounts, budgets |

**API response shape must match exactly** — run parity tests against captured Mongo fixtures.

### 12.3 Report services (highest effort)

| File | Approx. aggregate calls |
|------|-------------------------|
| `services/reportGeneratorService.js` | ~48 |
| `services/monthlyReportsService.js` | many |
| `services/annualReportsService.js` | many |
| `services/budgetService.js` | ~9 |

Strategy: convert one report at a time; cache in `report_snapshots` Postgres table (replaces `PrecomputedAggregation` capped collection).

### 12.4 `$lookup` → JOIN cheat sheet

```javascript
// Mongo
{ $lookup: { from: 'products', localField: 'product', foreignField: '_id', as: 'product' } }

// SQL
SELECT i.*, p.name AS product_name
FROM invoice_lines il
JOIN invoices i ON i.id = il.invoice_id
JOIN products p ON p.id = il.product_id
WHERE i.company_id = $1
```

### 12.5 `$facet` → conditional aggregates or UNION

Break facets into separate CTEs joined on grouping keys.

---

## 13. Step 8 — Transactions & sequences

> **Status (2026-07-25):** Foundation shipped on Neon PostgreSQL.
>
> - `services/transactionService.js` — `runInPrismaTransaction()` wraps
>   `prisma.$transaction` (5 s maxWait / 30 s timeout). Existing
>   `runInTransaction()` still uses Mongo sessions when `MONGODB_URI` is set;
>   otherwise runs non-transactionally (Mongo-backed domains unavailable).
> - `services/postgresSequenceStore.js` — atomic `INSERT … ON CONFLICT …
>   RETURNING` increments for `sequences` and `ebm_sequences`.
> - `services/sequenceService.js` — year-scoped and global counters on Postgres.
> - `services/ebmFiscalSequenceService.js` — EBM fiscal numbers on Postgres.
> - `models/utils/autoIncrement.js` — `generateUniqueNumber` delegates to
>   `sequenceService` when `DATABASE_URL` is set.
> - Prisma models: `SequenceCounter`, `EbmSequenceCounter`; migration
>   `20260725000001_phase0_sequences`.
> - ETL: `npm run etl:sequences` copies Mongo counters (needs `MONGODB_URI`).
> - Tests: `npm run test:phase0-step8` — 6/6 pass against Neon.
>
> **Deferred:** `journalService.js` posting still runs on MongoDB — migrate in
> Phase 5 (Finance) using `runInPrismaTransaction` + journal Prisma models.

### 13.1 Replace `runInTransaction`

```javascript
// services/transactionService.js — AFTER
const { prisma } = require('../lib/prisma');

async function runInTransaction(operation) {
  return prisma.$transaction(async (tx) => operation(tx), {
    maxWait: 5000,
    timeout: 30000,
  });
}

module.exports = { runInTransaction };
```

Postgres supports true ACID without replica-set caveats — remove the fallback path once migrated.

### 13.2 Journal posting (`services/journalService.js`)

Critical path — migrate early:

- Idempotent `(company_id, source_type, source_id)` unique partial index
- Insert header + lines in single `$transaction`
- Update `account_balances` in same transaction

### 13.3 Reference numbers (`models/Sequence.js`, `generateUniqueNumber`)

Replace with Postgres:

```sql
CREATE TABLE sequences (
  company_id CHAR(24) NOT NULL,
  name       VARCHAR(50) NOT NULL,
  value      BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (company_id, name)
);
```

Increment atomically:

```sql
UPDATE sequences SET value = value + 1
WHERE company_id = $1 AND name = $2
RETURNING value;
```

Or use Prisma `$executeRaw` in transaction with `SELECT ... FOR UPDATE`.

---

## 14. Step 9 — Phased domain migration order

Migrate in dependency order. **Do not skip phases.**

### Phase 0 — Foundation (Week 1–2) — DONE

- [x] Prisma bootstrap (Step 1)
- [x] `apiSerializer.js`, `prismaTenant.js`, `transactionService` Postgres path
- [x] ETL scaffolding (`scripts/etl/*`, phase0 sequences)
- [ ] CI Postgres service (GitHub Actions) — deferred

**Tables:** sequences, ebm_sequences (Step 8).

### Phase 1 — Tenancy & auth (Week 2–4) — DONE

| Models | Routes affected |
|--------|-----------------|
| `Company`, `User`, `CompanyUser`, `Role`, `RefreshToken`, `UserSession`, `IPWhitelist` | `/auth`, `/companies`, `/users`, `/access` |

Verified on Neon: login, refresh, `/me`, companies list. See Phase 1 status block at top of guide.

> **Status (2026-07-25):** `IPWhitelist` was left as a Mongoose model in the original
> Phase 1 pass, so `middleware/ipWhitelist.js` failed every `/api/access/*` request
> once `MONGODB_URI` was removed. Migration `20260725000007_ip_whitelist` adds the
> `ip_whitelists` table; `models/IPWhitelist.js` is now a `buildGlobalModel` shim
> (global rather than tenant-scoped because a null `company_id` means a
> platform-wide entry and every caller passes `company` explicitly). Mappers live in
> `utils/authMappers.js`. No ETL script — Mongo is already disconnected, so any entries
> that existed in the old `ipwhitelists` collection must be re-added through
> `/api/access/ip-whitelist`.

### Phase 2 — Master data (Week 4–6) — DONE (code + schema on Neon)

| Models | Routes |
|--------|--------|
| `Product`, `Category`, `Warehouse`, `Client`, `Supplier`, `ChartOfAccount`, `Tax`, `Currency`, `ExchangeRate`, `Department`, `TaxRate` | `/products`, `/categories`, `/warehouses`, `/clients`, `/suppliers`, `/chart-of-accounts`, `/taxes`, `/currencies`, `/exchange-rates`, `/departments` |

> **Status (2026-07-25):** Prisma models + migration `20260725000002_phase2_master_data`
> applied on Neon. All 11 Mongoose model files are Prisma-backed shims via
> `utils/masterDataCommon.js` + `utils/masterDataMappers.js`. Performance:
> composite indexes on `(company_id, code|sku|is_active)`, product list uses
> indexed columns + raw SQL for low-stock `$expr`. ETL: `npm run etl:phase2`
> (requires `MONGODB_URI` for one-time sync). Tests: `npm run test:phase2`.

**Rollout:** run `npm run etl:phase2` once with Mongo reachable, then restart API.

### Phase 3 — Inventory (Week 6–9) ✅ DONE

| Models | Routes |
|--------|--------|
| `StockLevel`, `StockMovement`, `InventoryBatch`, `InventoryLayer`, `StockTransfer*`, `StockAudit*`, `ReorderPoint`, `StockBatch`, `StockSerialNumber` | `/stock`, `/stock-transfers`, `/stock-audits`, `/batches`, `/serial-numbers` |

**High risk:** FIFO costing, COGS journal linkage.

> **Status (2026-07-25):** Migration `20260725000003_phase3_4_inventory_journal` applied on Neon.
> All inventory Mongoose models are Prisma-backed shims via `utils/inventoryJournalMappers.js`.
> Performance: composite indexes on `(company_id, product_id, warehouse_id)`,
> `(company_id, movement_date DESC)`, batch `(company_id, status, expiry_date)`,
> FIFO layers `(company_id, product_id, warehouse_id, receipt_date)`.
> Stock movements list uses indexed Prisma queries + populate from Postgres refs.
> ETL: `npm run etl:phase3-4` (requires `MONGODB_URI`). Tests: `npm run test:phase3-4`.

**Rollout:** run `npm run etl:phase3-4` once with Mongo reachable, then restart API.

### Phase 4 — Journal engine (Week 8–11, overlaps Phase 3) ✅ DONE

| Models | Routes |
|--------|--------|
| `JournalEntry`, `JournalEntryLine`, `AccountBalance`, `AccountMapping`, `Period`, `AccountingPeriod` | `/journal-entries`, `/accounting`, `/periods`, `/gl-financials` |

**Normalize:** single `journal_entry_lines` table; embedded `lines[]` preserved on read via JOIN.

Reference: existing `docs/module1_journal_engine_spec.md`.

> **Status (2026-07-25):** Journal lines normalized to `journal_entry_lines`; `JournalEntry.save()`
> writes header+lines in one Prisma transaction. `AccountBalance.adjust()` uses atomic upsert+increment.
> GL/trial balance queries hit indexed `(company_id, date DESC)` + line `(company_id, account_code)`.

### Phase 5 — Sales & AR (Week 11–14) ✅ DONE

| Models | Routes |
|--------|--------|
| `Quotation`, `SalesOrder`, `Invoice`, `InvoiceLine`, `CreditNote`, `DeliveryNote`, `ARReceipt`, `ARReceiptAllocation`, `RecurringInvoice*` | `/quotations`, `/sales-orders`, `/sales-invoices`, `/credit-notes`, `/delivery-notes`, `/ar`, `/recurring-invoices` |

**EBM:** Invoice EBM submission subdoc → JSONB column.

> **Status (2026-07-25):** Migration `20260725000004_phase5_6_sales_ap` applied on Neon.
> Line items normalized to child tables; API preserves embedded `lines[]`/`items[]` on read.
> Invoice list: indexed `(company_id, invoice_date DESC, status, due_date)` + lines JOIN with product.
> AR aging: indexed `ar_receipt_allocations(company_id, invoice_id)`.
> ETL: `npm run etl:phase5-6` (all 16 entity types). Tests: `npm run test:phase5-6`.

### Phase 6 — Purchases & AP (Week 14–17) ✅ DONE

| Models | Routes |
|--------|--------|
| `PurchaseOrder`, `Purchase`, `GoodsReceivedNote`, `PurchaseReturn`, `APPayment`, `APPaymentAllocation`, `FreightBill` | `/purchase-orders`, `/purchases`, `/grn`, `/purchase-returns`, `/ap`, `/payables` |

> **Status (2026-07-25):** PO/GRN/AP models on Postgres with normalized lines.
> AP aging: indexed `ap_payment_allocations(grn_id)` + GRN `(company_id, payment_status, payment_due_date)`.
> ETL syncs all Phase 5–6 collections (quotations, sales orders, invoices, credit notes,
> delivery notes, AR receipts/allocations, recurring invoices, POs, purchases, GRNs,
> purchase returns, AP payments/allocations, freight bills). Run `etl:phase2` first for FK refs.

### Phase 7 — Banking & petty cash (Week 17–19) ✅ DONE

| Models | Routes |
|--------|--------|
| `BankAccount`, `BankTransaction`, `BankStatementLine`, `BankReconciliation*`, `PettyCash*` | `/bank-accounts`, `/bank-reconciliation`, `/petty-cash` |

> **Status (2026-07-25):** Migration `20260725000005_phase7_9_banking_reports` applied on Neon.
> 13 Prisma models: 7 banking + 5 petty cash + `ReportSnapshot` (Phase 9 table created here).
> Bank account statics preserved (`getTotalCashPosition`, `getBalance`, `addTransaction`).
> Indexed `(company_id, bank_account_id, date DESC)` for transaction lists; reconciliation match uniques.
> ETL: `npm run etl:phase7-9`. Tests: `npm run test:phase7-9`.

### Phase 8 — Dashboards (Week 19–21) ✅ DONE

| Services | Routes |
|----------|--------|
| All 5 `services/dashboards/*.js`, `DashboardCacheService.js` | `/dashboard/*` |

**Frontend:** `Stock_tenancy_bnd` dashboard pages — zero changes if response parity holds.

> **Status (2026-07-25):** Dashboard services read banking/petty cash via Prisma shims (`BankAccount`, `PettyCashFloat`).
> Sales/inventory/purchase dashboards already on Phase 5–6 Prisma models. Journal/GL queries use Phase 4 shims.
> `DashboardCacheService` remains in-memory (no DB model). Budget widgets now read Phase 10 Postgres models.

### Phase 9 — Reports (Week 21–28) ✅ DONE

| Services | Routes |
|----------|--------|
| `reportGeneratorService.js`, daily/weekly/monthly/annual report services | `/reports/*` |

> **Status (2026-07-25):** `ReportSnapshot` on Postgres with JSONB `data`/`summary`/`comparison`.
> Report generators and scheduler use Prisma shim — same API (`findOne`, `findOneAndUpdate`, statics).
> Banking report sections (`cash-position`, `bank-reconciliation`, `petty-cash`) hit Phase 7 Postgres tables.
> ETL syncs 140 report snapshots from Mongo. Tests included in `test:phase7-9`.

### Phase 10 — Budget, payroll, assets, EBM (Week 28–36) ✅ DONE

| Domain | Models / services |
|--------|-------------------|
| Budget | `Budget*`, `Encumbrance`, `Project` |
| HR/Payroll | `Employee`, `PayrollRun`, `Timesheet`, `EmployeeAdvance` |
| Fixed assets | `FixedAsset`, `DepreciationEntry`, `AssetDisposalEvent` |
| EBM/RRA | All `EBM*` models, `ebmService.js`, sync services |

**EBM note:** Keep external RRA VSDC API integration unchanged; only persistence layer swaps.

> **Status (2026-07-25):** Migration `20260725000006_phase10_budget_payroll_assets_ebm` applied on Neon.
> 31 Prisma models (32 Mongo collections minus `EbmSequenceCounter`, already in schema).
> Mappers: `utils/phase10Mappers.js` (96 exports). Model shims for all domains; `postgresRefPlugin` extended.
> ETL: `npm run etl:phase10` — syncs assets (8+5+1+2+7), HR/payroll (4+4+5+9+3+4), budget (2+7+1+1+1+2+1),
> EBM (3 devices, 105 codes, 9 item classes, 5 TINs, 7 notices, 24 imported items, 17 unmatched purchases,
> 2 submission queues, 1 alert, 21 sync states). Zero-count collections (BudgetActualConsumption, BudgetAlert,
> Encumbrance) match Mongo. Parity: `npm run etl:verify-parity -- --phase=10`. Tests: `npm run test:phase10` (12/12).

**Rollout:** run `npm run etl:phase10` once with Mongo reachable (after Phases 2–9 ETL), then restart API.

### Phase 11 — Decommission MongoDB (Week 36+)

See [Step 14 — Final cutover checklist](#19-step-14--final-cutover-checklist).

---

## 15. Step 10 — Data migration (ETL)

### 15.1 Export from MongoDB

```bash
# Per collection — preserve extended JSON for ObjectIds and Decimal128
mongoexport --uri="$MONGODB_URI" --collection=invoices --out=etl/data/invoices.json --jsonArray
```

Or Node script using Mongoose cursor (handles Decimal128 → string):

```javascript
// scripts/etl/export-mongo.js
const invoice = doc.toObject({ flattenDecimals: true });
```

### 15.2 Transform rules

| Rule | Action |
|------|--------|
| `_id` | Copy to `id` CHAR(24) |
| `company` / `company_id` | Normalize to `company_id` |
| Embedded `lines[]` | Explode to child CSV/JSON |
| `Decimal128` | Parse to string, insert as NUMERIC |
| Dates | ISO → TIMESTAMPTZ |
| Missing FK targets | Log to `etl_skipped.log`, fail batch if > 0.1% |

### 15.3 Import to PostgreSQL

Use Prisma `createMany` in batches of 500–1000 with `$transaction`, or `COPY` for speed:

```sql
COPY invoice_lines FROM '/etl/invoice_lines.csv' CSV HEADER;
```

**Order:** respect FK dependency graph (companies → users → products → invoices → invoice_lines).

### 15.4 Verification script

`scripts/etl/verify-parity.js` must compare per company:

```javascript
// Count parity
mongoInvoices = await Invoice.countDocuments({ company: companyId });
pgInvoices = await prisma.invoice.count({ where: { companyId } });
assert.equal(mongoInvoices, pgInvoices);

// Sum parity (money)
mongoTotal = await Invoice.aggregate([{ $group: { _id: null, t: { $sum: '$totalAmount' } } }]);
pgTotal = await prisma.$queryRaw`SELECT SUM(total_amount) FROM invoices WHERE company_id = ${companyId}`;
```

Run verification for **every** migrated collection before domain cutover.

Phase-specific ETL scripts:

| Phase | Script | Parity flag |
|-------|--------|-------------|
| 2 | `npm run etl:phase2` | `--phase=2` |
| 3–4 | `npm run etl:phase3-4` | `--phase=3-4` |
| 5–6 | `npm run etl:phase5-6` | `--phase=5-6` |
| 7–9 | `npm run etl:phase7-9` | `--phase=7-9` |
| 10 | `npm run etl:phase10` | `--phase=10` |

Phase 10 ETL notes: `headerTranslateCreate` adds `createdById` for all tenant rows; models without that column
strip it via `KEEP_CREATED_BY` allowlist in `sync-phase10-mongo-to-postgres.js`. Embedded JSON (payroll run lines,
budget approval steps) is normalized with `toPlainJson()` (ObjectId → string, Decimal128 → number).

---

## 16. Step 11 — Dual‑write / strangler cutover

### 16.1 Per-domain lifecycle

```
┌──────────┐    ┌───────────────┐    ┌─────────────┐    ┌────────────┐
│ Mongo    │───►│ Dual-write    │───►│ Postgres    │───►│ Remove     │
│ only     │    │ (Mongo read)  │    │ only        │    │ Mongo      │
└──────────┘    └───────────────┘    └─────────────┘    └────────────┘
```

### 16.2 Feature flag per domain

```env
DOMAIN_PRODUCTS_BACKEND=postgres      # mongo | dual-write | postgres
DOMAIN_INVOICES_BACKEND=dual-write
DOMAIN_REPORTS_BACKEND=mongo
```

Repository factory reads domain-specific flag.

### 16.3 Dual-write implementation

```javascript
async function create(data) {
  const mongoDoc = await mongoRepo.create(data);
  try {
    await postgresRepo.create({ ...data, id: mongoDoc._id.toString() });
  } catch (err) {
    logger.error('Dual-write failed', { err, id: mongoDoc._id });
    // alert — do not fail user request during dual-write phase
  }
  return mongoDoc;
}
```

### 16.4 Read switch

1. Dual-write, **read Mongo** (verify Postgres async)
2. Dual-write, **read Postgres** with Mongo fallback on error
3. Postgres only

### 16.5 Background reconciler

Cron job compares Mongo vs Postgres counts and checksums per domain; alerts on drift.

---

## 17. Step 12 — Environment & deployment

### 17.1 New environment variables (production)

```env
DATABASE_URL=postgresql://user:pass@host:5432/stock_management?sslmode=require
DB_BACKEND=postgres
DOMAIN_*_BACKEND=postgres          # all domains after cutover
```

Remove after decommission:

```env
# MONGODB_URI=...                # DELETE
```

### 17.2 Render / staging (`render.yaml`)

Add Postgres addon; wire `DATABASE_URL` to web service.

Keep MongoDB addon during hybrid phase.

### 17.3 Migrations in CI/CD

```yaml
# .github/workflows/ci.yml — add:
services:
  postgres:
    image: postgres:16
    env:
      POSTGRES_PASSWORD: test
      POSTGRES_DB: stock_test
    ports:
      - 5432:5432

steps:
  - run: npx prisma migrate deploy
  - run: npm run test:integration
```

### 17.4 Connection pooling

Use PgBouncer in transaction mode for production, or Prisma Data Proxy for serverless.

Set in `DATABASE_URL`:

```
?connection_limit=20&pool_timeout=30
```

### 17.5 Backups

Replace MongoDB backup docs (`docs/DATABASE_BACKUPS.md`) with Postgres `pg_dump` schedule — keep both during hybrid.

---

## 18. Step 13 — Testing strategy

### 18.1 Test pyramid

| Layer | Tool | Purpose |
|-------|------|---------|
| Unit | Jest + mocked repos | Business logic |
| Integration | Jest + Testcontainers Postgres | Prisma queries, transactions |
| API contract | Supertest | Response shape vs golden fixtures |
| Parity | Custom `etl:verify` | Mongo vs Postgres data |
| E2E | Existing EBM e2e runner | Fiscal flows after EBM phase |

### 18.2 Required tests before each domain cutover

- [ ] All existing unit tests pass
- [ ] New integration tests for migrated repositories
- [ ] API contract snapshots match pre-migration captures
- [ ] ETL verify script passes for domain
- [ ] Manual smoke test of frontend screens for that domain

### 18.3 Frontend regression checklist (no code changes expected)

After each phase, verify in `Stock_tenancy_bnd`:

| Phase | Screens to smoke test |
|-------|----------------------|
| Auth | Login, company selector, session refresh |
| Master data | Products list, clients, suppliers, COA |
| Inventory | Stock levels, movements, transfers |
| Sales | Invoice create/confirm, invoice detail, EBM submit |
| Purchases | PO, GRN, purchase detail |
| Dashboards | All 5 COMMAND dashboards |
| Reports | P&L, balance sheet, daily reports |
| EBM | Control center, sync tabs |

### 18.4 Performance benchmarks

Capture p95 latency for top 20 endpoints on Mongo; require Postgres ≤ 1.2× Mongo p95 before cutover.

---

## 19. Step 14 — Final cutover checklist

### Pre-cutover (T-7 days)

- [ ] All domains at `DOMAIN_*_BACKEND=postgres`
- [ ] ETL verify passes for all companies in staging
- [ ] No dual-write errors in logs for 7 days
- [ ] Postgres backups verified (restore drill)
- [ ] Rollback runbook tested on staging

### Cutover day (T-0)

1. [ ] Enable maintenance banner (optional)
2. [ ] Stop background jobs writing to Mongo
3. [ ] Final incremental ETL sync (delta since last run)
4. [ ] Final parity verification — **abort if any mismatch**
5. [ ] Set `DB_BACKEND=postgres` globally
6. [ ] Deploy backend with Mongo connection code disabled
7. [ ] Run smoke tests (auth, invoice, stock movement, dashboard, EBM)
8. [ ] Monitor error rates and Postgres slow query log for 4 hours

### Post-cutover (T+1 to T+30)

- [ ] Remove Mongoose model requires from `server.js`
- [ ] Remove `mongoose`, `mongodb-memory-server` dependencies
- [ ] Archive MongoDB data (90-day retention)
- [ ] Decommission MongoDB Atlas cluster
- [ ] Update `docs/MONGODB_ATLAS_SETUP.md` → redirect to Postgres ops doc

---

## 20. Step 15 — Rollback plan

If critical issues within **72 hours** of cutover:

1. Set `DB_BACKEND=mongo` and redeploy previous Docker image
2. Replay writes that occurred on Postgres-only period from audit log (if dual-write was off — **data loss risk**; dual-write exists to prevent this)
3. Root-cause before second attempt

**Rollback is only safe if dual-write was active** or maintenance window with write freeze.

Keep MongoDB cluster alive **minimum 30 days** after cutover.

---

## Appendix A — Full model inventory

### Auth & tenancy
`Company`, `User`, `CompanyUser`, `Role`, `RefreshToken`, `UserSession`, `IPWhitelist`, `SystemSettings`, `Sequence`, `Period`, `AccountingPeriod`, `Currency`, `ExchangeRate`, `SubscriptionPlan`, `Subscription`, `AuditLog`, `ActionLog`, `Notification`, `NotificationSettings`, `Backup`, `Testimonial`, `PrecomputedAggregation`

### Inventory
`Product`, `Category`, `Warehouse`, `StockLevel`, `StockMovement`, `InventoryBatch`, `InventoryLayer`, `StockBatch`, `StockSerialNumber`, `SerialNumber`, `WarehouseInventoryCost`, `ReorderPoint`, `StockTransfer`, `StockTransferLine`, `StockAudit`, `StockAuditLine`, `PickPack`, `TillSession`, `CashDrawer`

### Sales & AR
`Client`, `Quotation`, `SalesOrder`, `Invoice`, `CreditNote`, `DeliveryNote`, `ARTransactionLedger`, `ARReceipt`, `ARReceiptAllocation`, `ARBadDebtWriteoff`, `RecurringInvoice`, `RecurringInvoiceRun`, `InvoiceReceiptMetadata`

### Purchases & AP
`Supplier`, `PurchaseOrder`, `Purchase`, `GoodsReceivedNote`, `PurchaseReturn`, `FreightBill`, `APTransactionLedger`, `APPayment`, `APPaymentAllocation`, `PaymentSchedule`

### GL & accounting
`ChartOfAccount`, `JournalEntry`, `JournalEntryLine`, `AccountBalance`, `AccountMapping`, `Tax`, `TaxRate`, `TaxTransaction`, `Expense`, `PrepaidExpense`, `DeferredRevenue`

### Banking
`BankAccount`, `BankTransaction`, `BankStatementLine`, `BankReconciliation`, `BankReconciliationMatch`, `BankReconciliationSession`, `BankStatementTransaction`, `FixedDeposit`, `InterestAccrual`, `PettyCashFloat`, `PettyCashExpense`, `PettyCashReplenishment`, `PettyCashTransaction`, `PettyCashReconciliation`

### Assets & liabilities
`AssetCategory`, `FixedAsset`, `DepreciationEntry`, `AssetStatusHistory`, `AssetDisposalEvent`, `Liability`, `Loan`, `Encumbrance`

### Budget & projects
`Budget`, `BudgetLine`, `BudgetActualConsumption`, `BudgetWorkflowConfig`, `BudgetApproval`, `BudgetRevision`, `BudgetTransfer`, `BudgetPeriodLock`, `BudgetAlert`, `Project`

### HR & payroll
`Department`, `Employee`, `SalaryHistory`, `Timesheet`, `Payroll`, `PayrollRun`, `EmployeeAdvance`

### EBM / RRA VSDC
`EBMDevice`, `EBMCode`, `EBMItemClass`, `EBMTIN`, `EBMNotice`, `EBMSequence`, `EBMSyncState`, `EBMImportedItem`, `EBMUnmatchedPurchase`, `EBMSubmissionQueue`, `EBMAlert`

### Import & reports
`ImportTemplate`, `ImportLog`, `ImportJob` (src/models), `ReportSnapshot`

---

## Appendix B — Route inventory (must stay unchanged)

Mount prefix: **`/api`** and **`/api/v1`** (both identical).

| Path | Route file |
|------|------------|
| `/auth` | `routes/authRoutes.js` |
| `/companies` | `routes/companyRoutes.js` |
| `/users` | `routes/userRoutes.js` |
| `/products` | `routes/productRoutes.js` |
| `/categories` | `routes/categoryRoutes.js` |
| `/suppliers` | `routes/supplierRoutes.js` |
| `/clients` | `routes/clientRoutes.js` |
| `/stock` | `routes/stockRoutes.js` |
| `/stock/warehouses` | `routes/warehouseRoutes.js` |
| `/stock/advanced` | `routes/advancedStockRoutes.js` |
| `/quotations` | `routes/quotationRoutes.js` |
| `/sales-orders` | `routes/salesOrderRoutes.js` |
| `/pick-packs` | `routes/pickPackRoutes.js` |
| `/sales-invoices` | `routes/invoiceRoutes.js` |
| `/purchases` | `routes/purchaseRoutes.js` |
| `/pos` | `routes/posRoutes.js` |
| `/dashboard` | `routes/dashboard.routes.js` + `routes/dashboardRoutes.js` |
| `/reports/*` | multiple report route files |
| `/journal-entries` | `routes/journalRoutes.js` |
| `/ebm` | `routes/ebmRoutes.js` |
| `/bank-accounts` | `routes/bankAccountRoutes.js` |
| `/petty-cash` | `routes/pettyCashRoutes.js` |
| `/budgets` | `routes/budgetRoutes.js` |
| `/payroll` | `routes/payrollRoutes.js` |
| ... | (see `server.js` lines ~200–400 for complete list) |

**Rule:** No route path, method, or mount point changes during migration.

---

## Appendix C — High‑risk areas

| Area | Risk | Mitigation |
|------|------|------------|
| Journal idempotency | Duplicate postings | Partial unique index on `(company_id, source_type, source_id)` |
| Invoice embedded lines | Response shape break | Serializer + parity tests; include lines in Prisma `include` |
| FIFO inventory costing | COGS mismatch | Parallel run stock valuation on staging |
| Dashboard aggregations | Wrong KPIs | Golden fixture tests per dashboard endpoint |
| EBM sequences | Fiscal receipt number gaps | Migrate `EBMSequence` with locked row increments |
| `company` vs `company_id` | Cross-tenant leak | Normalize + RLS + integration tests |
| Decimal precision | Rounding errors | `NUMERIC(19,4)` everywhere; never Float |
| Report cache | Performance regression | Materialized views or `report_snapshots` table |
| Tenant plugin bypass | Data leak | Audit all `skipTenant` usages (`grep skipTenant`) |

---

## Appendix D — Per‑phase file checklist

Use this when completing each phase.

### Files to create (once)
- [ ] `prisma/schema.prisma`
- [ ] `lib/prisma.js`
- [ ] `utils/apiSerializer.js`
- [ ] `utils/prismaTenant.js`
- [ ] `utils/sqlQuery.js`
- [ ] `repositories/index.js`
- [ ] `scripts/etl/export-mongo.js`
- [ ] `scripts/etl/import-postgres.js`
- [ ] `scripts/etl/verify-parity.js`

### Files to modify (per domain)
- [ ] `services/<domain>Service.js` — use repository factory
- [ ] `controllers/<domain>Controller.js` — add `deepSerialize()` if not present
- [ ] `repositories/prisma/<domain>.repository.js` — new
- [ ] `prisma/schema.prisma` — add models + migration
- [ ] `src/config/environment.js` — domain feature flags
- [ ] `.github/workflows/ci.yml` — Postgres service

### Files to remove (final decommission only)
- [ ] `config/database.js`
- [ ] `plugins/tenantPlugin.js`
- [ ] `utils/mongoAggregation.js`
- [ ] All `models/*.js` (131 files)
- [ ] `mongoose` dependency from `package.json`

---

## Quick start — Day 1 checklist

```bash
# 1. Start Postgres
docker compose -f docker-compose.postgres.yml up -d

# 2. Init Prisma
cd Stock_tenancy_system
npm install prisma @prisma/client
npx prisma init --datasource-provider postgresql

# 3. Add first models (Company, User, Role) to schema.prisma

# 4. Create migration
npx prisma migrate dev --name init_tenancy

# 5. Generate client
npx prisma generate

# 6. Wire lib/prisma.js + server.js connect

# 7. Implement company.repository.js + auth flow

# 8. Run login smoke test — frontend must work unchanged
```

---

*Document version: 1.0*  
*Generated from backend audit of `Stock_tenancy_system` — Mongoose 8, ~131 models, 79 route modules, Express `/api` + `/api/v1`.*
