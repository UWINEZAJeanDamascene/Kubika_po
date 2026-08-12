# Kubika AI Intelligence Engine

This folder contains the governed AI layer for Kubika. It is an integration layer above the existing ERP services.

Phase 0 establishes boundaries and shared contracts only. It must not change existing user-facing behavior.

Core rules:

- AI reads ERP data through existing services, not direct database clients.
- AI writes to ERP domains only through approved proposal workflows.
- Factual output must carry evidence metadata.
- Tenant, role, and company scoping must reuse the existing auth and permission model.
- LLM output is never the source of truth for numbers, permissions, or business actions.

