# Architecture Overview

> Mermaid diagrams for GitHub rendering.

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

    Dev -->|"Upload scripts / workflow XML, complete registry, download code"| System
    Admin -->|"Validate IDs, review reports, manage sessions"| System
    System -->|"Validate field/group/user IDs + Automation rule import proxy"| JiraCloud
    System -->|"S1+S2 classify/extract, RAG embeddings"| OpenAI
    System -->|"S4/S4b code generation with RAG context"| Anthropic
    System -->|"Weekly crawl for RAG index"| AtlDocs
```

---

## C4 — Container View

```mermaid
graph TB
    subgraph Browser
        Web["🌐 Web SPA<br/>React 18 + Vite<br/>Monaco Editor + Mermaid<br/>6 conditional tabs"]
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
        OpenAI["OpenAI API<br/>GPT-4o-mini"]
        Anthropic["Anthropic API<br/>Claude Sonnet 4.6"]
        AtlassianCloud["Atlassian Cloud<br/>REST API v3 + Automation"]
    end

    Web -->|"REST /api/v1/*"| API
    API -->|"Enqueue jobs"| Redis
    Worker -->|"Dequeue + process"| Redis
    Worker -->|"RAG read/write"| PG
    Worker -->|"S1+S2"| OpenAI
    Worker -->|"S4/S4b"| Anthropic
    API -->|"Automation import proxy"| AtlassianCloud
    API -->|"Schema init"| PG
    Web -.->|"Poll status"| API
```

---

## 6-Stage LLM Pipeline (with S4 fork)

```mermaid
graph LR
    Input["📄 Input<br/>.groovy/.java/.sil<br/>.xml workflow export"]

    S0["🔍 Stage 0<br/>Parser<br/><i>Deterministic</i><br/>WorkflowXML extractor<br/>CR-001–045 rules"]
    S1["📊 S1: Classify<br/>GPT-4o-mini<br/>500-800ms<br/>+ WorkflowContext signal"]
    S2["🔬 S2: Extract<br/>GPT-4o-mini<br/>600-1000ms"]
    S3["📚 S3: Retrieve<br/>pgvector<br/>50-100ms"]

    Fork{{"Target?"}}

    S4F["⚡ S4: Forge Generator<br/>Claude Sonnet<br/>6 SR extension points"]
    S4B["🔵 S4b: Automation Generator<br/>Claude Sonnet<br/>Automation rule JSON"]
    S4SR["📜 S4: SR Cloud Generator<br/>Claude Sonnet<br/>Groovy + REST v3"]
    S4SIL["🟢 S4: SIL→Forge Generator<br/>Claude Sonnet<br/>25 SIL→Forge mappings"]

    S5["✅ S5: Validate<br/>Deterministic<br/><50ms<br/>Skipped for automation-native"]

    Output["📦 Output<br/>Forge / SR / Automation Rule<br/>+ Mermaid Diagram"]

    Input --> S0 --> S1 --> S2 --> S3 --> Fork
    Fork -->|"forge-native / forge-remote"| S4F
    Fork -->|"automation-native"| S4B
    Fork -->|"scriptrunner-cloud"| S4SR
    Fork -->|"SIL language"| S4SIL
    S4F --> S5
    S4SR --> S5
    S4SIL --> S5
    S4B -.->|"skip"| S5
    S5 --> Output
```

---

## Migration Targets

```mermaid
graph TD
    Script["Script analysed"]

    IsLiveField{"Live Fields<br/>lf*() / getFieldById?"}
    IsLdap{"ldap() or<br/>File I/O?"}
    IsBehaviour{"SR Behaviour?"}
    IsFragment{"Velocity/HTML<br/>Fragment?"}
    IsSimple{"Simple logic?<br/>Low complexity?<br/>Mappable trigger?"}
    IsGroovySR{"Groovy +<br/>SR Cloud ok?"}

    MR["🔴 manual-rewrite"]
    AN["🔵 automation-native"]
    FN["⚡ forge-native"]
    FR["⚡ forge-remote"]
    SR["📜 scriptrunner-cloud"]
    FOS["⚡📜 forge-or-scriptrunner"]

    Script --> IsLiveField
    IsLiveField -->|"YES"| MR
    IsLiveField -->|"NO"| IsLdap
    IsLdap -->|"YES"| MR
    IsLdap -->|"NO"| IsSimple
    IsSimple -->|"YES — all ops mappable"| AN
    IsSimple -->|"NO"| IsBehaviour
    IsBehaviour -->|"YES"| FN
    IsBehaviour -->|"NO"| IsFragment
    IsFragment -->|"YES"| FN
    IsFragment -->|"NO"| IsGroovySR
    IsGroovySR -->|"YES"| FOS
    IsGroovySR -->|"NO"| FN
```

---

## Monorepo Package Graph

```mermaid
graph TD
    shared["@atlasreforge/shared<br/>Types + Constants"]
    tsconfig["@atlasreforge/tsconfig<br/>Base TS Config"]

    parser["@atlasreforge/parser<br/>Language Detection<br/>Module Type Detection (29 types)<br/>Dependency Extraction<br/>CR-001–045 Analyzer<br/>Workflow XML Parser"]
    rag["@atlasreforge/rag-engine<br/>Crawler + Embeddings<br/>+ pgvector Retrieval"]
    llm["@atlasreforge/llm-orchestrator<br/>6-Stage Pipeline S0→S5<br/>S4 / S4b / S4-SIL / S4-SR"]
    registry["@atlasreforge/field-registry<br/>Session Lifecycle<br/>+ Placeholders"]

    api["apps/api<br/>NestJS HTTP<br/>BullMQ Producer<br/>Automation proxy"]
    worker["apps/worker<br/>BullMQ Consumers<br/>Health Endpoint"]
    web["apps/web<br/>React SPA<br/>Monaco + Mermaid<br/>6 conditional tabs"]

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
