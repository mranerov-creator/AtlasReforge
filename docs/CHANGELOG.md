# Documentation Changelog

All notable documentation updates are tracked here. Each entry corresponds to code changes that required documentation updates.

---

## [1.2.1] — 2026-03-29

### Fixed — Worker Result Shape

- **Worker result wrapper**: `processMigration()` now wraps the orchestrator's `MigrationResult` with parser-derived metadata (`originalFilename`, `cloudReadinessLevel`, `recommendedTarget`, `complexity`, `linesOfCode`, `estimatedEffortHours`, `workflowContext`). Previously the real pipeline path omitted these fields (the mock path already had them), causing the frontend to display all-zero values.
- **API multipart type cast**: Added `as any` cast on `@fastify/multipart` plugin registration to resolve TS type version mismatch between the plugin and NestJS's bundled Fastify types.
- **SplitEditor language detection**: Guard against undefined filename in `detectLanguage()` preventing crash in Forge/ScriptRunner tabs.
- **ManualRewriteTab**: Guard against undefined `validationIssues` array preventing crash on `.filter()`.
- **S4 token budget**: Changed `maxTokens` from `Math.min(4000, estimated)` to `Math.max(2000, Math.min(8192, estimated))`. S1 classifier underestimated output tokens for some scripts, causing Claude to truncate its JSON response mid-output, resulting in `forgeFiles: null` and all-zero confidence scores.
- **S4 debug logging**: Added `console.log`/`console.error` to `s4-generator.ts` to log parse success (file count, maxTokens) or failure (raw content preview, error) for easier troubleshooting.

### Changed — Code Documentation

- `docs/code/worker.md` — Documented result wrapping logic (Phase 4)
- `docs/code/llm-orchestrator.md` — Token budget strategy documented

---

## [1.2.0] — 2026-03-28

### Added — Local Development

- `docs/INSTALL.md` — Full installation, startup, shutdown, and first-test guide
- `.env.local` support via `dotenv/config` in API and Worker entry points

### Fixed — Runtime & Robustness

- **Multipart upload**: Installed `@fastify/multipart@8` and registered plugin; rewrote `jobs.controller.ts` for Fastify-native `request.file()` (was using Express-style `@UploadedFile()`)
- **Package exports**: Added `require` entry to all 5 package.json exports for CJS/NestJS compatibility
- **Worker dev script**: Replaced `ts-node` with `tsx` (faster, no install prompt)
- **S4 JSON parser**: `parseJsonResponse` now uses 3-tier extraction strategy (direct parse → markdown fence strip → balanced-brace extraction) to handle Claude's variable output formatting
- **Frontend crash guards**:
  - `ReadinessBadge`: guards against undefined/unexpected `level` values (defaults to `red`)
  - `SummaryTab`: null guards for `businessLogic`, `confidence`, `estimatedEffortHours`
  - `ManualRewriteTab`: optional chaining for `businessLogic` properties

### Changed — Code Documentation

- `docs/code/llm-orchestrator.md` — Updated `parseJsonResponse` section with 3-tier strategy

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
