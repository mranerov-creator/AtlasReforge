# Documentation Changelog

All notable documentation updates are tracked here. Each entry corresponds to code changes that required documentation updates.

---

## [1.1.0] — 2026-03-28

### Added — Three-Level Documentation Structure

**Functional (Level 1)**
- `docs/functional/functional-analysis.md` — Full IEEE 830 spec with Mermaid state machines, sequence diagrams, activity flows
- `docs/functional/use-cases.md` — Detailed specifications for all 17 use cases (UC-01 through UC-17)

**Technical Design (Level 2)**
- `docs/technical/technical-design.md` — Architecture, package design, data model, security, testing, deployment
- `docs/technical/architecture.md` — C4 context/container views, pipeline, package graph, deployment topology (all Mermaid)
- `docs/technical/api-reference.md` — Complete REST API documentation with request/response schemas

**Code Documentation (Level 3)**
- `docs/code/packages-overview.md` — Monorepo dependency graph, build order, tooling
- `docs/code/parser.md` — Language detection, strategy dispatch, dependency extraction
- `docs/code/llm-orchestrator.md` — 5-stage pipeline, prompt security, provider abstraction
- `docs/code/rag-engine.md` — Crawler, chunker, embeddings, pgvector, DB pool, scheduler
- `docs/code/field-registry.md` — Session lifecycle, placeholder resolution, mapping types
- `docs/code/worker.md` — BullMQ consumers, health endpoint, graceful shutdown

**Infrastructure**
- `docs/README.md` — Documentation hub linking all three levels
- `docs/diagrams/` — Reorganized draw.io files (12 UML diagrams)
- `docs/legacy/` — Original Word documents preserved for reference

### Changed
- Updated documentation to reflect recent code additions:
  - `packages/rag-engine/src/db/pool.factory.ts` — PostgreSQL pool with retry + pgvector
  - `packages/rag-engine/src/crawler/crawl.scheduler.ts` — BullMQ weekly crawl schedule
  - `packages/rag-engine/src/seed/seed-rag.ts` — RAG index seed script
  - `apps/web/Dockerfile` — Multi-stage Docker build

---

## [1.0.0] — 2025-03

### Added
- Initial documentation in Word format
  - `AtlasReforge_FunctionalAnalysis.docx`
  - `AtlasReforge_TechnicalDesign.docx`
- 12 draw.io UML diagrams (FA-01 to FA-06, 01 to 06)
