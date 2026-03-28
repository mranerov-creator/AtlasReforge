# AtlasReforge AI — Documentation

> **Three-level documentation** for the AtlasReforge intelligent migration platform.

## 📚 Documentation Levels

### Level 1 — Functional Analysis

Business requirements, use cases, and functional specifications following IEEE 830 and UML 2.5 standards.

| Document | Description |
|----------|-------------|
| [Functional Analysis](functional/functional-analysis.md) | Scope, actors, activity diagrams, state machines, requirements (FR/NFR), business rules |
| [Use Case Specifications](functional/use-cases.md) | Detailed specifications for all 17 use cases (UC-01 through UC-17) |

### Level 2 — Technical Design

Architecture, API contracts, data design, security model, and deployment topology.

| Document | Description |
|----------|-------------|
| [Technical Design](technical/technical-design.md) | Executive summary, package design, data model, security, testing, performance |
| [Architecture Overview](technical/architecture.md) | C4 context/container views, deployment topology with Mermaid diagrams |
| [API Reference](technical/api-reference.md) | REST API endpoints, request/response schemas, status codes |

### Level 3 — Code Documentation

Package-level implementation details, public APIs, and configuration.

| Document | Description |
|----------|-------------|
| [Packages Overview](code/packages-overview.md) | Monorepo dependency graph, build order, package roles |
| [parser](code/parser.md) | Language detection, strategy dispatch, dependency extraction, cloud analysis |
| [llm-orchestrator](code/llm-orchestrator.md) | 5-stage pipeline (S1–S5), prompt security, provider abstraction |
| [rag-engine](code/rag-engine.md) | Crawler, chunker, embeddings, pgvector retrieval, DB pool, scheduler |
| [field-registry](code/field-registry.md) | Session lifecycle, placeholder resolution, mapping types |
| [worker](code/worker.md) | BullMQ consumers, job processing, health endpoint, graceful shutdown |

## 📐 UML Diagrams (draw.io)

All diagrams are in [`docs/diagrams/`](diagrams/) and can be opened at [app.diagrams.net](https://app.diagrams.net) or with the VS Code draw.io extension.

| File | Type | Content |
|------|------|---------|
| `FA-01-use-case.drawio` | UML Use Case | 17 use cases, 4 actors, «include»/«extend» |
| `FA-02-activity-migration.drawio` | UML Activity | Migration workflow: 6 swim lanes, fork/join |
| `FA-03-activity-registry.drawio` | UML Activity | Registry workflow: parallel mapping branches |
| `FA-04-state-machines.drawio` | UML State Machine | Job (8 states) + Registry session (7 states) |
| `FA-05-sequence-uc01.drawio` | UML Sequence | UC-01: 7 lifelines, alt fragment, async separator |
| `FA-06-dfd-rtm.drawio` | DFD + RTM | Data flow + Requirements Traceability Matrix |
| `01-c4-context.drawio` | C4 Context | System boundary, external actors |
| `02-c4-container.drawio` | C4 Container | Internal containers, packages, data stores |
| `03-sequence-pipeline.drawio` | UML Sequence | Complete 5-stage pipeline |
| `04-class-parser.drawio` | UML Class | Parser domain model, strategies |
| `05-erd-database.drawio` | ERD | rag_documents table, indexes |
| `06-deployment.drawio` | UML Deployment | Docker Compose topology |

## 📋 Changelog

See [CHANGELOG.md](CHANGELOG.md) for documentation version history.

## 📁 Legacy Documents

Original Word documents are preserved in [`docs/legacy/`](legacy/) for reference.
