# Architecture Overview

> Mermaid diagrams for GitHub rendering. See also: [01-c4-context.drawio](../diagrams/01-c4-context.drawio), [02-c4-container.drawio](../diagrams/02-c4-container.drawio), [06-deployment.drawio](../diagrams/06-deployment.drawio)

---

## C4 — System Context

```mermaid
graph TB
    Dev["👤 Atlassian Developer"]
    Admin["👤 Atlassian Administrator"]
    
    subgraph AtlasReforge["⚡ AtlasReforge AI"]
        System["Intelligent Migration Platform"]
    end
    
    JiraCloud["☁️ Jira Cloud REST API v3"]
    OpenAI["🤖 OpenAI API"]
    Anthropic["🤖 Anthropic API"]
    AtlDocs["📄 Atlassian Developer Docs"]
    
    Dev -->|"Upload scripts, complete registry, download code"| System
    Admin -->|"Validate IDs, review reports, manage sessions"| System
    System -->|"Validate field/group/user IDs"| JiraCloud
    System -->|"S1+S2 classify/extract, RAG embeddings"| OpenAI
    System -->|"S4 code generation with RAG context"| Anthropic
    System -->|"Weekly crawl for RAG index"| AtlDocs
```

---

## C4 — Container View

```mermaid
graph TB
    subgraph Browser
        Web["🌐 Web SPA<br/>React 18 + Vite<br/>Monaco Editor + Mermaid"]
    end
    
    subgraph Backend
        API["⚙️ API Server<br/>NestJS + Fastify<br/>Port 3001"]
        Worker["🔧 Worker<br/>Node.js + BullMQ<br/>Concurrency: 3"]
    end
    
    subgraph Data
        Redis["📦 Redis 7<br/>BullMQ broker<br/>Job state + TTL 24h"]
        PG["🗄️ PostgreSQL 16<br/>pgvector extension<br/>RAG index"]
    end
    
    subgraph External
        OpenAI["OpenAI API"]
        Anthropic["Anthropic API"]
    end
    
    Web -->|"REST /api/v1/*"| API
    API -->|"Enqueue jobs"| Redis
    Worker -->|"Dequeue + process"| Redis
    Worker -->|"RAG read/write"| PG
    Worker -->|"S1+S2"| OpenAI
    Worker -->|"S4"| Anthropic
    API -->|"Schema init"| PG
    Web -.->|"Poll status"| API
```

---

## 5-Stage LLM Pipeline

```mermaid
graph LR
    Input["📄 Script<br/>.groovy/.java/.sil"]
    
    S0["🔍 Stage 0<br/>Parser<br/><i>Deterministic</i>"]
    S1["📊 S1: Classify<br/>GPT-4o-mini<br/>500-800ms"]
    S2["🔬 S2: Extract<br/>GPT-4o-mini<br/>600-1000ms"]
    S3["📚 S3: Retrieve<br/>pgvector<br/>50-100ms"]
    S4["⚡ S4: Generate<br/>Claude Sonnet 4<br/>5-12s"]
    S5["✅ S5: Validate<br/>Deterministic<br/><50ms"]
    Output["📦 Output<br/>Forge + SR Code<br/>+ Diagram"]
    
    Input --> S0 --> S1 --> S2 --> S3 --> S4 --> S5 --> Output
```

---

## Monorepo Package Graph

```mermaid
graph TD
    shared["@atlasreforge/shared<br/>Types + Constants"]
    tsconfig["@atlasreforge/tsconfig<br/>Base TS Config"]
    
    parser["@atlasreforge/parser<br/>Language Detection<br/>+ Dependency Extraction"]
    rag["@atlasreforge/rag-engine<br/>Crawler + Embeddings<br/>+ pgvector Retrieval"]
    llm["@atlasreforge/llm-orchestrator<br/>5-Stage Pipeline<br/>S1→S5"]
    registry["@atlasreforge/field-registry<br/>Session Lifecycle<br/>+ Placeholders"]
    
    api["apps/api<br/>NestJS HTTP<br/>+ BullMQ Producer"]
    worker["apps/worker<br/>BullMQ Consumers<br/>+ Health Endpoint"]
    web["apps/web<br/>React SPA<br/>Monaco + Mermaid"]
    
    parser --> shared
    parser --> tsconfig
    rag --> shared
    rag --> tsconfig
    llm --> shared
    llm --> tsconfig
    registry --> shared
    registry --> tsconfig
    
    api --> parser
    api --> registry
    api --> shared
    
    worker --> parser
    worker --> llm
    worker --> rag
    worker --> registry
    worker --> shared
    
    web --> tsconfig
```

---

## Deployment Topology (Docker Compose)

```mermaid
graph TB
    subgraph "Docker Compose Network"
        subgraph "Frontend"
            web["web:3000<br/>nginx + React SPA<br/>Multi-stage Dockerfile"]
        end
        
        subgraph "Backend Services"
            api["api:3001<br/>NestJS + Fastify"]
            worker["worker:3002<br/>BullMQ Workers<br/>/health endpoint"]
        end
        
        subgraph "Data Layer"
            redis["redis:6379<br/>Redis 7.4-alpine<br/>BullMQ broker"]
            postgres["postgres:5432<br/>pgvector/pgvector:pg16<br/>RAG index"]
        end
    end
    
    web -->|"/api/* proxy"| api
    api --> redis
    worker --> redis
    worker --> postgres
    api --> postgres
    
    classDef healthy fill:#2d5,stroke:#1a3,color:#fff
    class postgres,redis healthy
```

**Startup Order:** `postgres` → `redis` → `api` → `worker` → `web` (all use `service_healthy` conditions)

---

## Data Flow

```mermaid
flowchart LR
    subgraph "Ephemeral (Memory + Redis 24h)"
        Script["Script Content"]
        JobData["BullMQ Job Payload"]
        Session["Registry Session"]
        LLMResp["LLM Responses"]
    end
    
    subgraph "Persistent (PostgreSQL)"
        RAG["rag_documents<br/>vector(1536)"]
    end
    
    Script -->|"HTTP POST"| JobData
    JobData -->|"Worker processes"| LLMResp
    LLMResp -->|"Result in Redis"| JobData
    
    RAG -->|"S3 retrieval"| LLMResp
    
    style Script fill:#f96,stroke:#c63
    style JobData fill:#f96,stroke:#c63
    style Session fill:#f96,stroke:#c63
    style LLMResp fill:#f96,stroke:#c63
    style RAG fill:#6bf,stroke:#38d
```

> ⚠️ **Orange = ephemeral** (never persisted). **Blue = persistent** (only RAG docs, never customer code).
