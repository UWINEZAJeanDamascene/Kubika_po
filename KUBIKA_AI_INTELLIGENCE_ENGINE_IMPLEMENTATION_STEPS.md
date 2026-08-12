# Kubika AI Intelligence Engine Implementation Steps

## My Assessment

The `KUBIKA_AI_INTELLIGENCE_ENGINE (1).md` document is a strong product and engineering direction. The best part is that it treats AI as a controlled intelligence layer, not just a chat widget. Its strongest principles are:

- AI reads business data only through existing Kubika services.
- AI writes nothing directly; it prepares proposals that require explicit human approval.
- Every factual statement must be grounded in real Kubika records.
- The LLM is not trusted as the source of truth for numbers, rules, permissions, or actions.
- Scheduled monitoring, findings, reports, forecasts, and recommendations are first-class features.

That is the right architecture for an ERP. For a stock, finance, payroll, and accounting system, hallucination is not a small UX issue; it is a business-control failure. The document correctly makes truthfulness, tenant isolation, auditability, and approval gates architectural requirements.

The main risk is size. The document describes a full intelligence platform: context builder, knowledge model, BI engine, prompt builder, provider router, decision engine, recommendation engine, action engine, reports, monitoring jobs, forecasts, guardrails, and UI experiences. Trying to build all chapters at once would likely create a fragile system. The better path is to evolve the existing Stacy assistant into this architecture in controlled phases.

The current codebase already has useful starting points:

- Backend chat route: `routes/aiChatRoutes.js`
- Provider fallback service: `services/aiProviderService.js`
- Backend AI tools: `services/aiToolService.js`
- Frontend assistant: `Stock_tenancy_bnd/src/app/components/AIChatBot.tsx`
- Frontend business-context helpers: `Stock_tenancy_bnd/src/lib/businessContext.ts`, `morningBriefing.ts`, `predictiveAnalytics.ts`, `knowledgeBase.ts`
- Existing auth, tenant context, rate limiting, Redis, cron/jobs, audit logs, Mongoose, Prisma, and many domain services

My recommendation: do not replace Stacy. Promote Stacy from a frontend-heavy chat assistant into a backend-governed AI Intelligence Engine.

## Non-Negotiable Implementation Rules

1. Do not let AI modules import Prisma, raw SQL clients, or Mongoose models directly, except for the AI-specific persistence models/tables.
2. Do not let the LLM calculate financial numbers. Backend code calculates; the LLM explains.
3. Do not let action-intent messages execute business operations directly.
4. Every response, finding, report, forecast, and proposal must carry evidence metadata.
5. Every AI request must use existing auth, company scoping, and role permissions.
6. Every AI-generated action must be staged as a proposal and executed only after approval.
7. Start with deterministic rules before adding LLM narration.

## Target Backend Structure

Use a new backend folder under `Stock_tenancy_system`:

```text
ai-engine/
  gateway/
  context-builder/
  knowledge-model/
  prompt-builder/
  llm-router/
  decision-engine/
  recommendation-engine/
  action-engine/
  nlq/
  guardrail/
  reports/
  predictive/
  monitoring/
  shared/
    interfaces/
    dto/
  tests/
    unit/
    integration/
    adversarial/
```

This can coexist with the current `routes/aiChatRoutes.js` and `services/aiProviderService.js` during migration.

## Phase 0: Architecture Preparation

Goal: create the AI layer boundaries without changing user-facing behavior.

Steps:

1. Create `ai-engine/shared/interfaces` with core contracts:
   - `FactRecord`
   - `AIContext`
   - `AIResponse`
   - `AIFinding`
   - `AIRecommendation`
   - `AIActionProposal`
   - `AIForecast`

2. Define the first `FactRecord` shape:

```js
{
  id: "fact_...",
  companyId: "...",
  domain: "sales|inventory|finance|payroll|purchases|customers|suppliers|reports",
  label: "Monthly sales",
  value: 1200000,
  unit: "RWF",
  sourceType: "service",
  sourceService: "DashboardService",
  sourceMethod: "getStats",
  sourceIds: ["..."],
  computed: false,
  formula: null,
  permissions: ["reports.read"],
  observedAt: "2026-08-05T..."
}
```

3. Add an AI dependency-boundary check script:
   - Fail if files under `ai-engine/` import Prisma directly.
   - Fail if files under `ai-engine/` import raw SQL utilities.
   - Fail if `action-engine/` imports mutating ERP services directly.

4. Add `npm` scripts:
   - `test:ai`
   - `test:ai:adversarial`
   - `ai:check-boundaries`

5. Document provider privacy review in `.env.example` comments before production use.

Acceptance:

- The repo has an AI folder, shared contracts, and CI-checkable boundaries.
- No existing user workflow changes.

## Phase 1: Backend Context Builder

Goal: move business context out of the frontend and into a governed backend service.

Steps:

1. Create `ai-engine/context-builder/ContextBuilder.js`.
2. Create collector modules:
   - `SalesContextCollector.js`
   - `InventoryContextCollector.js`
   - `FinanceContextCollector.js`
   - `PurchasingContextCollector.js`
   - `CustomerContextCollector.js`
   - `SupplierContextCollector.js`
   - `PayrollContextCollector.js`
   - `ReportsContextCollector.js`

3. Each collector must call existing services only. It should not query the database directly.
4. Each collector returns `FactRecord[]`, never free-form prompt text.
5. Add permission filtering before facts are returned.
6. Add Redis/in-memory cache by `companyId`, `userId`, permission hash, query domain, and date window.
7. Add an endpoint:

```text
POST /api/ai/context
```

Request:

```json
{
  "query": "Why are profits down this month?",
  "domains": ["sales", "finance"],
  "dateRange": {
    "from": "2026-08-01",
    "to": "2026-08-05"
  }
}
```

Response:

```json
{
  "success": true,
  "context": {
    "facts": [],
    "warnings": [],
    "metadata": {}
  }
}
```

Acceptance:

- Chat can retrieve backend-built context.
- Facts include provenance.
- Permission-restricted users cannot receive facts from forbidden modules.

## Phase 2: Knowledge Model And KPI Registry

Goal: centralize Kubika business definitions so every AI component uses the same formulas.

Steps:

1. Create `ai-engine/knowledge-model`.
2. Add dictionaries for:
   - Entity names and aliases
   - Module relationships
   - Rwanda tax/accounting terminology
   - Common business questions mapped to required facts

3. Add a KPI registry for:
   - Gross profit
   - Gross margin
   - Net profit
   - Inventory turnover
   - Days sales outstanding
   - Days payable outstanding
   - Stockout risk
   - Dead stock
   - VAT collected
   - VAT payable
   - Payroll cost ratio

4. Implement deterministic formula functions in backend code.
5. Attach formula traces to derived `FactRecord`s.

Acceptance:

- The same KPI requested from chat, reports, and monitoring produces the same number.
- Every computed value includes formula, inputs, and source facts.

## Phase 3: Prompt Builder And Guardrail

Goal: make LLM responses structured, grounded, and mechanically verifiable.

Steps:

1. Create `ai-engine/prompt-builder`.
2. Move the current large system prompt from `routes/aiChatRoutes.js` into versioned prompt templates.
3. Build a prompt contract that sends:
   - User question
   - Allowed facts
   - Allowed action intents
   - Output schema
   - Safety rules

4. Create `ai-engine/guardrail`.
5. Require LLM responses to use a structured shape:

```json
{
  "answer": "",
  "claimLabels": [
    {
      "text": "",
      "type": "FACT|ANALYSIS|PREDICTION|RECOMMENDATION|ASSUMPTION",
      "factIds": []
    }
  ],
  "missingData": [],
  "recommendedActions": []
}
```

6. Reject or regenerate responses when:
   - A FACT has no `factIds`.
   - A number appears without supporting evidence.
   - The response claims an action was executed.
   - Tenant/company IDs do not match.
   - The response includes sensitive fields not allowed for the user.

Acceptance:

- Unsupported factual claims are blocked before reaching the user.
- Provider/model metadata is returned with every response.

## Phase 4: LLM Router Upgrade

Goal: adapt the existing `services/aiProviderService.js` into the formal LLM router from the spec.

Steps:

1. Keep the current provider fallback foundation.
2. Add provider-order config:
   - Groq
   - Gemini
   - Mistral
   - OpenRouter
   - DeepSeek
   - Together
   - Ollama/local, dev only

3. Add circuit-breaker states:
   - closed
   - open
   - half-open

4. Track per provider:
   - latency
   - failures
   - rate limits
   - guardrail rejection count
   - quota metadata where available

5. Add strict JSON mode or response schema where each provider supports it.
6. Send guardrail failures to the next provider, not only retry the same provider.

Acceptance:

- Simulated provider outage falls through to the next provider.
- Simulated malformed output falls through or regenerates safely.
- Response metadata records provider and model.

## Phase 5: Natural Language Query Engine

Goal: classify user intent before deciding whether to answer, report, forecast, or create a proposal.

Steps:

1. Create `ai-engine/nlq/IntentClassifier.js`.
2. Classify messages into:
   - factual query
   - analytical query
   - causal query
   - forecast query
   - report request
   - recommendation request
   - action intent
   - help/how-to query
   - ambiguous query

3. Implement deterministic routing first with keyword/rule patterns.
4. Use LLM classification only as fallback for ambiguous cases.
5. Route action intent to the Action Engine proposal flow.

Acceptance:

- "Create a purchase order" never becomes a chat answer claiming completion.
- Ambiguous queries ask a clarifying question.

## Phase 6: Decision Engine

Goal: produce findings from deterministic business rules, then use LLM only for explanation.

Steps:

1. Create `ai-engine/decision-engine`.
2. Add rule packs:
   - inventory risk rules
   - cash flow rules
   - receivable aging rules
   - payable aging rules
   - sales trend rules
   - gross margin rules
   - duplicate payment/anomaly rules
   - tax/compliance deadline rules

3. Add confidence scoring based on:
   - evidence completeness
   - data freshness
   - rule certainty
   - historical consistency
   - model/forecast uncertainty when applicable

4. Persist findings in an AI-specific store:
   - `ai_findings`
   - or Mongoose `AIFinding`

5. Each finding includes:
   - title
   - summary
   - severity
   - confidence
   - domain
   - status
   - evidence fact IDs
   - recommended next step

Acceptance:

- Rules can run without an LLM provider configured.
- Every finding can show "why" using source facts.

## Phase 7: Recommendation Engine

Goal: rank what the business should do next.

Steps:

1. Create `ai-engine/recommendation-engine`.
2. Rank findings by:
   - financial impact
   - urgency
   - confidence
   - user role relevance
   - recurrence
   - legal/tax/compliance risk

3. Add recommendation types:
   - reorder stock
   - follow up overdue receivable
   - investigate anomaly
   - reduce slow-moving inventory
   - review supplier pricing
   - prepare tax/payment reminder
   - review cash shortage risk

4. Convert recommendation candidates into either:
   - informational recommendation
   - action proposal candidate

Acceptance:

- Recommendations are sorted consistently.
- Low-confidence recommendations are labeled clearly.

## Phase 8: Action Engine And Approval Workflow

Goal: safely prepare actions without autonomous execution.

Steps:

1. Create `ai-engine/action-engine`.
2. Add an AI-specific proposal model/table:
   - `ai_action_proposals`

3. Proposal fields:
   - companyId
   - createdBy
   - type
   - status: draft, pending_approval, approved, rejected, executed, failed
   - payload
   - evidenceFactIds
   - riskLevel
   - approvalRequiredByRole
   - approvedBy
   - executedAt
   - executionResult

4. Supported initial proposal types:
   - purchase order draft
   - payment reminder draft
   - stock adjustment review request
   - supplier follow-up task
   - customer follow-up task

5. Add endpoints:

```text
POST /api/ai/proposals
GET /api/ai/proposals
GET /api/ai/proposals/:id
POST /api/ai/proposals/:id/approve
POST /api/ai/proposals/:id/reject
POST /api/ai/proposals/:id/execute
```

6. Execution endpoint must check:
   - authenticated user
   - company scope
   - permission
   - proposal status is approved
   - payload still valid

7. Execution calls existing ERP services only.
8. Log every proposal lifecycle event into the existing audit log.

Acceptance:

- No AI action is executable without approval.
- Rejected proposals cannot execute.
- Cross-tenant proposal access fails.

## Phase 9: Scheduled Monitoring And Daily Briefings

Goal: make the engine proactive.

Steps:

1. Create `ai-engine/monitoring`.
2. Use existing cron/BullMQ infrastructure.
3. Schedule tenant-scoped jobs:
   - daily business briefing
   - inventory risk scan
   - cash/receivables/payables scan
   - sales trend scan
   - tax/compliance reminders
   - anomaly/fraud scan

4. Store generated briefings in AI-specific persistence.
5. Push high-severity findings through the existing notification system.
6. Add fatigue controls:
   - max alerts per day
   - group repeated findings
   - snooze
   - dismiss
   - per-user preferences

Acceptance:

- A tenant receives a daily briefing generated from real facts.
- High-severity findings create notifications.
- Dismissed or snoozed findings do not keep repeating noisily.

## Phase 10: AI Reports

Goal: create auditable AI-enhanced reports.

Steps:

1. Create `ai-engine/reports`.
2. Start with reports that map naturally to current ERP modules:
   - daily business briefing
   - inventory risk report
   - cash flow risk report
   - receivables collection risk report
   - payables pressure report
   - sales performance report
   - anomaly/fraud review report

3. Every report must contain:
   - executive summary
   - findings
   - evidence/data used
   - calculations
   - recommendations
   - missing-data caveats
   - generated by provider/model/version metadata

4. Reuse existing export infrastructure where possible.

Acceptance:

- Reports can be viewed and exported.
- Every number in a report traces to facts or computed formulas.

## Phase 11: Predictive Intelligence

Goal: add forecasts carefully, with uncertainty shown clearly.

Steps:

1. Create `ai-engine/predictive`.
2. Start with deterministic/statistical forecasts before ML:
   - moving average
   - trend extrapolation
   - seasonality-aware baseline where enough data exists

3. Forecast:
   - revenue
   - cash balance
   - inventory stockout date
   - receivable collection risk
   - payable pressure

4. Persist forecasts:
   - `ai_forecasts`

5. Always include:
   - confidence interval
   - assumptions
   - source facts
   - model version
   - back-test metrics when available

Acceptance:

- Forecasts never present as guaranteed outcomes.
- Forecast output includes confidence intervals and assumptions.

## Phase 12: Frontend Productization

Goal: expose the intelligence layer as a working business control surface, not only a chat panel.

Steps:

1. Keep the existing Stacy chat, but make it call the backend AI Gateway instead of building most business context in the browser.
2. Add an Intelligence page with tabs:
   - Briefing
   - Findings
   - Recommendations
   - Forecasts
   - Reports
   - Proposals
   - Provider Health

3. Add "show evidence" UI for each answer/finding/report.
4. Add proposal approval/rejection screens.
5. Add notification preferences for AI findings.
6. Add provider health admin view using `/api/ai/providers`.

Acceptance:

- Users can inspect evidence before trusting an AI answer.
- Users can approve/reject proposals from the UI.
- Chat and Intelligence pages share the same backend facts.

## Phase 13: Security And Adversarial Tests

Goal: prove the AI layer cannot bypass core ERP controls.

Steps:

1. Add adversarial tests for:
   - prompt injection
   - "ignore permissions" requests
   - "create without approval" requests
   - cross-tenant probing
   - unsupported factual claims
   - fake citation IDs
   - sensitive PII leakage

2. Add integration tests for:
   - context permission filtering
   - proposal approval gate
   - audit logging
   - provider fallback
   - guardrail rejection

3. Add static checks for:
   - no direct DB access
   - no action-engine mutating imports
   - prompt template snapshots

Acceptance:

- Security tests run in CI.
- A failed guardrail blocks the response.
- A malicious prompt cannot trigger a mutating ERP operation.

## Phase 14: Observability And Rollout

Goal: launch safely and improve from measured behavior.

Steps:

1. Track metrics:
   - chat latency
   - first-token latency if streaming is added
   - context builder latency
   - guardrail rejection rate
   - provider failure rate
   - provider quota usage
   - finding acceptance/dismissal rate
   - proposal approval/rejection rate
   - forecast accuracy/back-test error

2. Add feature flags:
   - AI chat v2
   - proactive findings
   - proposals
   - forecasts
   - reports

3. Roll out in order:
   - internal/admin tenant
   - one test company
   - selected beta tenants
   - all tenants

4. Keep an emergency kill switch for:
   - provider calls
   - scheduled monitoring
   - proposal execution

Acceptance:

- AI can be disabled without affecting core ERP.
- Production rollout has measurable quality and safety signals.

## Suggested MVP

The minimum useful version should include only:

1. Backend Context Builder with provenance.
2. Knowledge Model and KPI registry for sales, inventory, cash, receivables, and payables.
3. Guarded chat responses with fact citations.
4. Provider router improvements with metadata and fallback.
5. Deterministic findings for inventory risk, overdue receivables, payables pressure, and sales decline.
6. Daily briefing generated by scheduled job.
7. Intelligence page showing findings and evidence.

Do not include autonomous proposals, advanced forecasts, or full AI reports in the first release. Those are valuable, but they depend on the grounding and guardrail foundation being reliable first.

## Immediate Next Engineering Tasks

1. Create `ai-engine/shared/interfaces`.
2. Create backend `ContextBuilder`.
3. Convert existing frontend `businessContext.ts` logic into backend collectors.
4. Modify `routes/aiChatRoutes.js` to call backend Context Builder before the LLM.
5. Add `GuardrailService` with basic fact-citation validation.
6. Add `AIFinding` persistence model/table.
7. Add first deterministic finding rules:
   - low stock
   - overdue receivables
   - payable overdue
   - sales down versus previous period
8. Add tests for tenant isolation and unsupported-claim rejection.

## Final Opinion

This is a very good direction for Kubika. The document understands the difference between "AI that talks about the business" and "AI that safely operates around business data." The second one is much harder, but it is also much more valuable.

The implementation should be staged carefully. Build the evidence layer first, then guarded answers, then deterministic findings, then recommendations, then proposals and forecasts. Once the facts and guardrails are solid, the rest of the intelligence engine can grow without putting the ERP at risk.
