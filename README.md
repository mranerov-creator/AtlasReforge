# AtlasReforge AI

> Intelligent migration platform for Atlassian Server/Data Center → Cloud

**AtlasReforge** analyzes legacy Atlassian scripts (Groovy, Java, SIL) and generates production-ready Cloud equivalents using a 5-stage LLM pipeline with RAG, deterministic dependency extraction, and a Field Mapping Registry.

---

## Architecture

```
AtlasReforge/
├── packages/
│   ├── parser/           # 🎯 Stage 0: Multi-strategy code analysis
│   │   ├── detectors/    # Language (Groovy/Java/SIL) + Module type
│   │   ├── extractors/   # Deterministic dep extraction (regex, no LLM)
│   │   ├── analyzers/    # Cloud readiness 🟢🟡🔴 (pure function)
│   │   └── strategies/   # AST / LLM-Semantic / Hybrid dispatch
│   ├── rag-engine/       # Stage 3: pgvector + Atlassian docs crawler
│   ├── llm-orchestrator/ # Stages 1-5: 5-stage pipeline
│   ├── field-registry/   # Field/Group/User mapping (Server → Cloud)
│   └── shared/           # Cross-package types and utilities
├── apps/
│   ├── api/              # NestJS — HTTP orchestrator + BullMQ producer
│   ├── worker/           # BullMQ consumers — heavy pipeline jobs
│   └── web/              # React SPA — Monaco + Mermaid + ADS
└── infra/
    ├── docker-compose.yml
    └── k8s/              # Self-hosted enterprise deployment
```

## LLM Pipeline (5 Stages)

```
[Input script] → S1: Classify (GPT-4o-mini, cheap)
                   ↓ {type, language, complexity}
              → S2: Extract (AST/LLM/Hybrid)
                   ↓ {fields, groups, users, deprecated APIs}
              → S3: RAG Retrieval (pgvector similarity)
                   ↓ {Forge docs, REST API v3 examples}
              → S4: Generate (Claude Sonnet — Forge/SR code)
                   ↓ {forgeCode, srCode, mermaidDiagram}
              → S5: Validate (auto-check for deprecated API usage)
                   ↓ [Final output with confidence scores]
```

## Parser Strategy Selection

| Language | Condition | Strategy |
|----------|-----------|----------|
| Java | Always | `AstStrategy` (tree-sitter-java) |
| Groovy | No metaprogramming | `AstStrategy` (tree-sitter-groovy) |
| Groovy | Heavy metaprogramming | `HybridStrategy` (AST + LLM gap analysis) |
| SIL | Always | `LlmSemanticStrategy` (no public grammar) |

## Key Design Decisions

- **No LLM in the extraction phase** — dependency extraction is 100% deterministic regex. LLM only runs for SIL (no grammar) and Hybrid gap-filling.
- **Ephemeral processing** — uploaded script content is never persisted to disk or DB. Only the `ParsedScript` metadata output is stored.
- **Field Mapping Registry** — required before code generation. Maps `customfield_XXXXX` (Server) → `customfield_YYYYY` (Cloud), group names, and usernames → accountIds.
- **Cloud-only rules** — the analyzer has zero tolerance for `ComponentAccessor`, filesystem access, direct SQL, or username/userKey usage in generated code.

## Prerequisites

- Node.js >= 20 LTS
- pnpm >= 9
- Docker + Docker Compose v2

## Setup

```bash
# Clone
git clone https://github.com/mranerov-creator/AtlasReforge
cd AtlasReforge

# Enable pnpm via corepack
corepack enable
corepack prepare pnpm@9.14.2 --activate

# Install all workspace dependencies
pnpm install

# Configure environment
cp .env.example .env.local
# Edit .env.local — add ANTHROPIC_API_KEY and OPENAI_API_KEY

# Start infrastructure (Postgres + Redis)
docker compose -f infra/docker-compose.yml up postgres redis -d

# Build all packages
pnpm build

# Run tests
pnpm test

# Start full dev environment
pnpm dev
```

## Running the Parser in isolation

```typescript
import { ParserService } from '@atlasreforge/parser';

const parser = new ParserService({
  llmClient: myAnthropicClient, // Required for SIL + Hybrid
  enableAst: true,
});

const result = await parser.parse({
  content: myGroovyScript,
  filename: 'budget-approval.groovy',
});

console.log(result.cloudReadiness.overallLevel); // 'green' | 'yellow' | 'red'
console.log(result.dependencies.customFields);   // [{fieldId: 'customfield_10048', ...}]
console.log(result.dependencies.users);           // GDPR: all username refs
```

## Environment Variables

See `.env.example` for the full contract. Critical variables:

| Variable | Description |
|----------|-------------|
| `ANTHROPIC_API_KEY` | Claude Sonnet for Stage 4 code generation |
| `OPENAI_API_KEY` | GPT-4o-mini for Stage 1 classification |
| `DATABASE_URL` | Postgres with pgvector extension |
| `DISABLE_PERSISTENCE` | Set `true` to prevent raw code from being stored |
| `EPHEMERAL_JOB_TTL_MS` | Auto-purge jobs after N ms (default: 300000) |

## Security & Enterprise

- **Ephemeral processing**: user code processed in memory, never written to disk
- **Tenant isolation**: each job runs in isolated worker thread or container
- **Self-hosted**: full Docker Compose stack — deploy on-premises for air-gapped environments
- **GDPR**: all `username`/`userKey` references are flagged and must be resolved to `accountId`

---

*Built with: pnpm workspaces · Turborepo · TypeScript 5.7 · NestJS · BullMQ · pgvector · Vitest*
