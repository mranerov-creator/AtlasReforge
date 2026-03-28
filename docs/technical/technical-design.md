# Technical Design Document

> **Version:** 1.1 — Updated March 2026  
> **Status:** Draft — Internal Review  
> **Tech Stack:** TypeScript · NestJS · React · BullMQ · pgvector · OpenAI · Anthropic  
> **Repository:** [github.com/mranerov-creator/AtlasReforge](https://github.com/mranerov-creator/AtlasReforge)

---

## 1. Executive Summary

AtlasReforge AI is an intelligent migration platform that automates the transition of Atlassian Server and Data Center automation scripts to their Atlassian Cloud equivalents. The system addresses the fundamental architectural shift from synchronous, in-memory Java APIs to asynchronous, REST-based Cloud APIs — a migration that currently requires senior consultants spending 8–30 hours per script.

The platform operates via a **5-stage LLM pipeline** backed by a Retrieval-Augmented Generation (RAG) index of live Atlassian documentation. A deterministic **Field Mapping Registry** resolves environment-specific IDs (custom field IDs, group names, usernames) that differ between Server and Cloud environments.

**Key Result:** 80% reduction in migration effort — from ~15 consultant-hours to ~3 AI-assisted hours per complex script.

### 1.1 Business Problem

Three categories of incompatibility:

1. **API paradigm shift:** Server uses synchronous Java APIs (`ComponentAccessor`, `IssueManager`) with no Cloud equivalent. Cloud requires async REST with rate limits, pagination, and OAuth.
2. **Environment-specific IDs:** `customfield_10048` has different numeric IDs in every Cloud instance.
3. **GDPR compliance:** Usernames/userKeys deprecated in Cloud. Must use `accountId` (opaque UUID).

### 1.2 Solution Overview

| Capability | Description |
|-----------|-------------|
| Intelligent parsing | Multi-signal language detection (Groovy/Java/SIL), Strategy Pattern dispatch, deterministic dependency extraction, pure-function Cloud readiness scoring |
| RAG-grounded generation | Weekly-updated vector index of 28 Atlassian doc pages prevents LLM hallucination |
| Field Mapping Registry | UI-driven resolution of environment-specific IDs with `ATLAS_*()` placeholders |
| Auto-validation | Stage 5 checks 12 rules (VAL_001–VAL_061) and auto-fixes common issues |

---

## 2. Architecture

> **Diagrams:** See [Architecture Overview](architecture.md) for Mermaid renderings.  
> **Draw.io:** [01-c4-context](../diagrams/01-c4-context.drawio), [02-c4-container](../diagrams/02-c4-container.drawio), [06-deployment](../diagrams/06-deployment.drawio)

### 2.1 Architectural Principles

- **Ephemeral processing:** Script content never persisted to disk or long-term storage. Redis TTL: 24h. Hard constraint.
- **Graceful degradation:** `NoopRagRetriever` fallback if DB unavailable. Mock results without API keys.
- **Determinism where possible:** S1–S2 detection/extraction and S5 validation are deterministic/LLM-free. Only S1, S2, S4 make LLM calls. S3 is pure vector search.
- **Monorepo with clear boundaries:** Each package has typed public API (`index.ts`), own tests, explicit dependencies. Cross-package deps flow downward only.

### 2.2 Container Architecture

| Container | Technology | Responsibility |
|-----------|-----------|----------------|
| Web SPA | React 18 + Vite | Monaco Editor split view, Mermaid diagrams, Registry UI, job polling |
| API Server | NestJS + Fastify | Multipart ingestion, BullMQ producer, Registry CRUD, job status |
| Worker | Node.js + BullMQ | 5-stage pipeline, RAG crawl processor, weekly schedule, graceful drain |
| Redis 7 | Redis:7.4-alpine | BullMQ queue broker, job state/results (24h TTL), repeatable schedule |
| PostgreSQL 16 | pgvector/pgvector:pg16 | RAG index with vector(1536), IVFFlat cosine similarity |

---

## 3. Package Design

> **Detailed code documentation:** See [Code Documentation](../code/packages-overview.md)

### 3.1 @atlasreforge/parser

The parser is the foundational package. Its output — `ParsedScript` — is the typed contract all downstream stages consume.

**Language Detection** — Multi-signal scoring engine:
- File extension (weight: 40) — highest signal
- Syntax patterns (weight: 30) — language-specific constructs
- Atlassian API patterns (weight: 10) — ScriptRunner, ComponentAccessor
- Negative signals — patterns that exclude a language

**Strategy Pattern:** Three parse strategies dispatched by detected language:

| Strategy | Languages | Mechanism |
|----------|-----------|-----------|
| AstStrategy | Java, standard Groovy | tree-sitter grammars (optional native bindings) |
| LlmSemanticStrategy | SIL (no public grammar) | LLM with 50+ curated few-shot patterns |
| HybridStrategy | Groovy with metaprogramming | AST for static + LLM for dynamic regions |

**Dependency Extraction** — Deterministic regex, no LLM:
- Custom field IDs with usage type (read/write/search)
- Group references (`groupManager.getGroup()`, etc.)
- User references — GDPR critical (`getUserByName()`, `runAs()`)
- External HTTP calls, REST endpoint references, deprecated APIs

**Cloud Compatibility Analysis** — 20 rules (CR-001 to CR-020):
- RED = blockers (-25 pts), YELLOW = paradigm shifts (-10 pts), GREEN = confirmations
- Pure function, no LLM, synchronously executable, exhaustively unit testable

### 3.2 @atlasreforge/llm-orchestrator

5-stage desynchronised pipeline with typed inputs/outputs:

| Stage | Model | Input | Output |
|-------|-------|-------|--------|
| S1 Classify | GPT-4o-mini | ParsedScriptShell | moduleType, complexity, migrationTarget, costEstimate |
| S2 Extract | GPT-4o-mini | ParsedScript + S1 | enrichedFields, businessLogic, detectedPatterns |
| S3 Retrieve | pgvector | S1 + S2 outputs | Top-10 ranked doc chunks (≤8 parallel queries) |
| S4 Generate | Claude Sonnet 4 | All prior + raw script | forgeFiles/srCode, diagram, confidence, placeholders |
| S5 Validate | Deterministic | S4 output | issues, autoFixCount, patched files |

**Meta-Prompt Security:**
- Script content always in XML-delimited tags (untrusted code)
- Models output ONLY valid JSON — no prose, no markdown
- Temperature 0.0 for extraction (S1, S2), 0.2 for generation (S4)
- FORBIDDEN APIs enumerated in S4 system prompt, caught by S5

**Placeholder Pattern:**
```typescript
const fieldId = ATLAS_FIELD_ID("customfield_10048");
const groupId = ATLAS_GROUP_ID("jira-finance-team-PROD");
const userId  = ATLAS_ACCOUNT_ID("jsmith");
```

### 3.3 @atlasreforge/rag-engine

**Corpus:** 28 Atlassian doc pages across 6 categories (forge-api, rest-api-v3, oauth-scopes, scriptrunner-cloud, migration-guide, forge-manifest).

**Chunking:** 500 tokens/chunk, 50-token overlap. Code blocks never split. SHA-256 change detection.

**Vector Search:** pgvector cosine similarity with IVFFlat (lists=100). Up to 8 parallel queries per job, deduplicated by document ID, capped at 10 results.

**DB Pool** (`pool.factory.ts`): PostgreSQL connection pool with retry logic (exponential backoff, max 5 retries), pgvector extension verification, schema initialization, health checks.

**Crawl Scheduler** (`crawl.scheduler.ts`): BullMQ repeatable job registered at worker startup. Default: Monday 02:00 UTC. Manual trigger via `triggerManualCrawl()`.

**Seed Script** (`seed-rag.ts`): One-time initial population of the RAG index. Crawls all 28 URLs, chunks, and embeds.

### 3.4 @atlasreforge/field-registry

**Session Lifecycle:**
- Created immediately after parsing (before LLM)
- Bootstrapped from `DependencyMap`
- 24-hour TTL, never persisted to DB
- `isComplete: true` when all mappings resolved
- `completionBlockers`: list of entities blocking deployment

**Placeholder Resolution** — pure function:
- `ATLAS_FIELD_ID("x")` → mapped Cloud field ID or SKIPPED comment
- `ATLAS_GROUP_ID("x")` → mapped Cloud group UUID
- `ATLAS_ACCOUNT_ID("x")` → resolved accountId

---

## 4. Data Design

### 4.1 Database Schema

> **Diagram:** [05-erd-database.drawio](../diagrams/05-erd-database.drawio)

Only persistent store is PostgreSQL + pgvector. Minimal by design.

**Table: `rag_documents`**

| Column | Type | Description |
|--------|------|-------------|
| id | TEXT (PK) | SHA-256(url + chunkIndex), deterministic |
| source_url | TEXT | Original documentation URL |
| category | TEXT | forge-api \| rest-api-v3 \| oauth-scopes \| ... |
| content | TEXT | Plain text chunk (HTML stripped) |
| content_hash | TEXT | SHA-256 for change detection |
| embedding | vector(1536) | OpenAI text-embedding-3-small |
| has_code_block | BOOLEAN | Prioritised in retrieval |
| crawled_at | TIMESTAMPTZ | Freshness tracking |

**Indexes:**
- `IVFFlat(embedding vector_cosine_ops, lists=100)` — similarity search
- `(source_url, content_hash)` — change detection O(1)
- `(crawled_at)` — stale document cleanup

### 4.2 In-Memory Data (Ephemeral)

| Data | Storage | TTL | Note |
|------|---------|-----|------|
| Script content | Redis BullMQ job payload | 24h | Automatically purged |
| Registry sessions | InMemoryRegistryStore | 24h | Never persisted |
| OAuth access tokens | Per-request memory | Request | Never logged |
| LLM responses | Memory | Request | Not cached |

> **Security principle:** AtlasReforge never stores customer IP in any durable storage.

---

## 5. API Design

> **Full reference:** See [API Reference](api-reference.md)

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | /api/v1/jobs | Submit script (multipart ≤512KB) |
| GET | /api/v1/jobs/:jobId/status | Poll progress (0-100%) |
| GET | /api/v1/jobs/:jobId/result | Get completed result |
| GET | /api/v1/registry/:jobId | Get registry session |
| PUT | /api/v1/registry/:jobId/fields | Map custom field |
| PUT | /api/v1/registry/:jobId/groups | Map group |
| PUT | /api/v1/registry/:jobId/users | Map user → accountId |
| POST | /api/v1/registry/:jobId/resolve | Resolve placeholders |
| GET | /health | Liveness probe |

---

## 6. Security Design

### 6.1 Threat Model

| Threat | Mitigation |
|--------|-----------|
| Prompt injection | XML-delimited tags, explicit untrusted code instruction |
| Data exfiltration | Ephemeral processing, 24h TTL, no disk writes |
| Cross-job contamination | UUID-keyed sessions, BullMQ job isolation |
| LLM hallucination of insecure code | S5 auto-validator with 12 rules |

### 6.2 Mitigations

**Prompt Injection Prevention:**
- Script wrapped in `<script>` XML tags with explicit "untrusted user code" instruction
- `</script>` sequences sanitised before wrapping
- Size limits: 10K chars (S4), 8K (S2), 6K (S1)

**Ephemeral Processing:**
- Flow: HTTP body → API memory → Redis job → Worker memory → discard
- `DISABLE_PERSISTENCE=true` enforced
- No shared mutable state between concurrent jobs

**Generated Code Safety (S5):**
- VAL_001–006: Zero tolerance for Server Java APIs
- VAL_010–012: GDPR — zero username/userKey
- VAL_020: Auto-upgrade REST v2 → v3
- VAL_030–032: Forge safety (egress, loops, pagination)

---

## 7. Testing Strategy

### 7.1 Test Pyramid

| Layer | Count | Scope |
|-------|-------|-------|
| Unit Tests | 159 | Pure functions, all LLM mocked, no DB/Redis/HTTP |
| Integration (mock DB) | 2 | RAG write→retrieve with MockPgPool |
| Integration (real DB) | 2 | pgvector cosine similarity, schema init |
| Smoke Test | 4 assertions | Parser → Registry → Placeholder resolution |

### 7.2 Key Decisions

- **tree-sitter as optionalDependencies** — tests use `enableAst: false` in CI
- **Mock LLM clients** — `vi.fn()` providers returning fixture JSON
- **InMemoryRegistryStore** — same `RegistryStore` interface as Redis-backed production store
- **`describe.skipIf(!hasRealDb)`** — integration tests auto-skip without `DATABASE_URL`

---

## 8. Deployment

> **Diagram:** [06-deployment.drawio](../diagrams/06-deployment.drawio)

### 8.1 Docker Compose (Development)

```bash
docker-compose -f infra/docker-compose.yml up
```

Health checks ensure startup order: postgres → redis → api → worker → web. All `service_healthy` conditions.

### 8.2 First-Time Setup

```bash
# 1. Start infrastructure
docker-compose up postgres redis -d

# 2. Seed RAG index (one-time, ~3 min, ~$0.01)
DATABASE_URL=... OPENAI_API_KEY=... pnpm --filter @atlasreforge/rag-engine seed

# 3. Start all services
docker-compose up
```

Or set `RAG_SEED_ON_STARTUP=true` for auto-seed.

### 8.3 Weekly Crawl Schedule

- **Schedule:** Every Monday 02:00 UTC (configurable via `ATLASSIAN_DOCS_CRAWL_SCHEDULE`)
- **Cost:** ~$0.004/week (only changed pages re-embedded)
- **Failure recovery:** Job queued if worker down, processed on restart

### 8.4 Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| OPENAI_API_KEY | For LLM | GPT-4o-mini (S1+S2) + text-embedding-3-small |
| ANTHROPIC_API_KEY | For LLM | Claude Sonnet 4 (S4 code generation) |
| DATABASE_URL | Yes | PostgreSQL + pgvector connection |
| REDIS_URL | Yes | Redis for BullMQ |
| WORKER_CONCURRENCY | No | Parallel jobs. Default: 3 |
| RAG_SEED_ON_STARTUP | No | Auto-seed empty index. Default: false |
| ATLASSIAN_DOCS_CRAWL_SCHEDULE | No | Cron. Default: `0 2 * * 1` |
| EPHEMERAL_JOB_TTL_MS | No | Job TTL. Default: 300000 |

---

## 9. Performance & Cost

### 9.1 Pipeline Latency

| Stage | Duration | Bottleneck |
|-------|----------|-----------|
| Parse (sync) | < 100ms | Deterministic regex |
| S1 Classify | 500–800ms | GPT-4o-mini latency |
| S2 Extract | 600–1000ms | GPT-4o-mini latency |
| S3 Retrieve | 50–100ms | pgvector IVFFlat |
| S4 Generate | 5–12s | Claude Sonnet 4 |
| S5 Validate | < 50ms | Deterministic regex |
| **Total** | **6–14 seconds** | Dominated by S4 |

### 9.2 Cost per Job

| Component | Model | Tokens | Cost |
|-----------|-------|--------|------|
| S1 Classifier | GPT-4o-mini | ~500 | ~$0.0001 |
| S2 Extractor | GPT-4o-mini | ~1000 | ~$0.0002 |
| S3 RAG query | text-embedding-3-small | ~50 | < $0.0001 |
| S4 Generator | Claude Sonnet 4 | ~3500 | ~$0.025 |
| **Total** | — | ~5000 | **~$0.03–$0.05** |

---

## 10. Technology Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Monorepo manager | pnpm + Turborepo | Distributed build cache for 6-package CI |
| HTTP framework | NestJS + Fastify | 2x Express throughput on file uploads; native DI |
| Queue | BullMQ (not Bull) | Bull in maintenance; BullMQ v2 with native TS |
| Vector DB | pgvector | SQL-native, IVFFlat, no separate service |
| Test framework | Vitest | 10x faster than Jest in monorepo TS |
| Classifier | GPT-4o-mini | Fast, cheap for S1+S2 classification |
| Generator | Claude Sonnet 4 | Best code generation quality with RAG grounding |
| SIL parsing | LLM semantic | No public grammar; ~87% confidence with few-shot |

---

## Glossary

| Term | Definition |
|------|------------|
| SIL | Simple Issue Language — proprietary Adaptavist scripting, no public grammar |
| RAG | Retrieval-Augmented Generation — doc chunks injected as LLM context |
| pgvector | PostgreSQL extension for vector storage and similarity search |
| BullMQ | Redis-backed job queue with priorities, retries, repeatable jobs |
| accountId | Atlassian Cloud user UUID replacing deprecated username/userKey |
| OFBiz | Entity engine under Jira Server/DC — impossible in Cloud |
| Forge | Atlassian serverless platform replacing Connect |
| IVFFlat | Approximate nearest-neighbour algorithm in pgvector |
| ATLAS_FIELD_ID() | Placeholder resolved by Field Mapping Registry |
