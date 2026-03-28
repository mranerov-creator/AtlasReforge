# Use Case Specifications

> Detailed specifications for all 17 use cases. See [Functional Analysis](functional-analysis.md) for context.

---

## Ingestion Domain

### UC-01 — Submit Script for Migration

| Field | Value |
|-------|-------|
| **Actors** | Atlassian Developer (Primary) |
| **Preconditions** | User has a `.groovy`, `.java`, or `.sil` script. File ≤ 512 KB. System is running. |
| **Postconditions** | BullMQ job enqueued. RegistrySession created with detected deps. User receives `jobId`, `statusUrl`, `registryUrl`. |
| **Trigger** | User drags a file to upload zone or calls `POST /api/v1/jobs`. |
| **Priority** | MUST HAVE |

**Description:** Primary entry point. Script is parsed synchronously (no LLM) to extract dependencies and bootstrap the Field Mapping Registry before enqueuing the async LLM pipeline.

**Main Flow:**
1. User opens `http://localhost:3000` and sees the upload page.
2. User drags-and-drops a `.groovy` / `.java` / `.sil` file (or clicks to browse).
3. Web SPA validates file: extension ∈ {.groovy, .java, .sil, .SIL, .txt}, size ≤ 512 KB, content non-empty.
4. `POST /api/v1/jobs` (multipart: file + SubmitJobDto) sent to API.
5. API invokes `ParserService.parse()` — multi-signal language detection, dependency extraction, cloud readiness analysis.
6. API invokes `RegistryService.buildSession()` — creates RegistrySession with customFields[], groups[], users[].
7. API enqueues `MigrationJobData` to BullMQ "migration" queue (Redis, TTL 24h).
8. API returns HTTP 202 `{ jobId, registryUrl, statusUrl }`.
9. Web SPA redirects to `/workspace/:jobId` showing pipeline progress stepper.

**Alternative Flows:**
- **UC-01-A:** REST API submission (programmatic) — same validation, returns 202 JSON.
- **UC-01-B:** Script has zero detectable dependencies — RegistrySession created with `isComplete = true` immediately.
- **UC-01-C:** ZIP file containing multiple scripts — each creates a separate job (batch mode, future).

**Exceptions:**
- **EX-01-1:** Wrong extension → 422 "File type not supported"
- **EX-01-2:** >512 KB → 422
- **EX-01-3:** Empty file → 422
- **EX-01-4:** Parser throws → 500, job not enqueued

---

### UC-02 — View Cloud Readiness Report

| Field | Value |
|-------|-------|
| **Actors** | Atlassian Developer (Primary), Atlassian Administrator (Secondary) |
| **Preconditions** | UC-01 complete. Job status = "completed". |
| **Postconditions** | User has reviewed readiness score, business logic summary, ROI estimate, confidence scores. |
| **Trigger** | Job status polling returns "completed" OR user selects "Summary" tab. |
| **Priority** | MUST HAVE |

**Main Flow:**
1. Frontend polls `GET /jobs/:jobId/status` with exponential backoff (1s → max 10s).
2. When status = "completed", frontend renders Summary tab.
3. System displays Cloud Readiness Badge: 🟢 ≥70 / 🟡 40–69 / 🔴 <40 with numeric score.
4. System displays recommended migration target: Forge Native | Forge Remote | ScriptRunner Cloud.
5. System displays Business Logic section: trigger description, purpose narrative, conditions, actions.
6. System displays Confidence Score bars: field mapping, webhook logic, user resolution, OAuth scopes, overall.
7. System displays Validation Issues: errors (red), warnings (amber), auto-fixed (green badge count).
8. System displays ROI Calculator: Consultant Xh → AI-assisted Yh → Z% savings.
9. System displays detected OAuth scopes as code chips.

**Alternative Flows:**
- **UC-02-A:** status = "failed" → error message + retry guidance
- **UC-02-B:** Administrator view — includes multi-job triage table

---

## Field Mapping Registry Domain

### UC-04 — Map Custom Field to Cloud ID

| Field | Value |
|-------|-------|
| **Actors** | Atlassian Developer (Primary) |
| **Preconditions** | UC-01 complete. At least one CustomFieldMapping with status = "unmapped". |
| **Postconditions** | `CustomFieldMapping.status = "mapped"`. cloudFieldId stored. `session.isComplete` re-evaluated. |
| **Trigger** | User enters a Cloud field ID and clicks "Save". |
| **Priority** | MUST HAVE |

**Description:** Custom field IDs (`customfield_XXXXX`) differ between Server and Cloud. Generated code uses `ATLAS_FIELD_ID("customfield_XXXXX")` placeholders resolved after mapping.

**Main Flow:**
1. Registry Panel renders "Custom Fields" section listing all detected fields.
2. Each row shows: serverFieldId, inferred business purpose, usage type, status badge.
3. User enters Cloud field ID (e.g., `customfield_10201`) in text input.
4. User clicks "Save".
5. `PUT /api/v1/registry/:jobId/fields { serverFieldId, cloudFieldId }`.
6. `RegistryService.updateField()` sets status = "mapped".
7. `session.isComplete` re-evaluated; `completionBlockers` updated.
8. Row updates to show ✓ Mapped badge within 500ms.

---

### UC-05 — Map Group to Cloud Group

Similar to UC-04 but for group name resolution. Server group names may differ from Cloud group UUIDs.

---

### UC-06 — Resolve User → accountId (GDPR Critical)

| Field | Value |
|-------|-------|
| **Actors** | Atlassian Developer (Primary) |
| **Preconditions** | Session has ≥1 UserMapping with `gdprRisk = "high"`. |
| **Postconditions** | `UserMapping.cloudAccountId` populated. Generated code MUST NOT contain username/userKey. |
| **Trigger** | User selects resolution strategy + enters accountId. |
| **Priority** | MUST HAVE |

**Description:** Usernames and userKeys are deprecated in Cloud (GDPR). All user references must use the opaque accountId UUID. This is the most critical mapping.

**Main Flow:**
1. Registry Panel renders Users section with ⚠ GDPR high badge for each unmapped user.
2. User selects resolution strategy: Migration API | Manual lookup | Service account | Remove.
3. User enters Cloud accountId (UUID).
4. `PUT /api/v1/registry/:jobId/users { serverIdentifier, cloudAccountId, resolutionStrategy }`.
5. `RegistryService.updateUser()` stores mapping, status = "mapped".
6. `session.isComplete` and `completionBlockers` re-evaluated.

**Alternative Flows:**
- **UC-06-A:** Strategy = "Remove" — status = "skipped"
- **UC-06-B:** Strategy = "Service account" — shared service accountId
- **UC-06-C:** Bulk-map via JSON import (UC-09)

---

### UC-07 — Skip Mapping

Developer marks a mapping as "not needed in Cloud". Status = "skipped". The generated code placeholder will be replaced with an inline comment.

---

### UC-08 — Validate Mappings vs Jira Cloud

Validates all mapped IDs against Jira Cloud REST API v3 before accepting them. Requires an OAuth access token.

---

### UC-09 — Export / Import Registry Session

Export session as JSON for reuse across jobs targeting the same Cloud tenant.

---

## Code Generation Domain

### UC-10 — View Generated Forge Code

| Field | Value |
|-------|-------|
| **Actors** | Atlassian Developer (Primary) |
| **Preconditions** | Job status = "completed". `MigrationResult.forgeFiles` is non-null. |
| **Postconditions** | User has reviewed manifest.yml, TypeScript resolvers in Monaco split editor. |
| **Trigger** | User selects "⚡ Forge" tab. |
| **Priority** | MUST HAVE |

**Main Flow:**
1. SplitEditor renders in split-view mode.
2. Left pane: original script, read-only. Deprecated patterns highlighted with red wavy underline.
3. Right pane: generated Forge files with tab selector (manifest.yml, src/index.ts, etc.).
4. Validation badge row: N auto-fixed (green), M errors (red), P warnings (amber).
5. If `ATLAS_*()` placeholders remain: banner "Complete Field Mapping Registry to resolve X placeholders".

---

### UC-11 — View Generated ScriptRunner Cloud Code

Similar to UC-10 but displays Groovy code targeting ScriptRunner Cloud with REST API v3 calls.

---

### UC-12 — View Migration Sequence Diagram

Renders a Mermaid sequence diagram describing the Cloud event flow generated by S4.

---

### UC-13 — Resolve Placeholders in Generated Code

| Field | Value |
|-------|-------|
| **Actors** | Atlassian Developer (Primary) |
| **Preconditions** | `session.isComplete = true`. Code contains `ATLAS_*()` placeholders. |
| **Postconditions** | All placeholders replaced with Cloud IDs. Code ready for `forge deploy`. |
| **Trigger** | `session.isComplete` becomes true (auto) or user clicks "Resolve Now". |
| **Priority** | MUST HAVE |

**Main Flow:**
1. `POST /api/v1/registry/:jobId/resolve { code }`.
2. PlaceholderResolver scans for `ATLAS_FIELD_ID()`, `ATLAS_GROUP_ID()`, `ATLAS_ACCOUNT_ID()`.
3. For each: lookup mapped value. Mapped → replace. Skipped → inline comment.
4. Returns `{ resolvedCode, totalPlaceholders, resolved, unresolved }`.
5. SplitEditor refreshes with resolved code.
6. Shows "✅ N/N placeholders resolved — code ready for forge deploy".

---

### UC-14 — Download Generated Code

Download all generated files as a ZIP archive.

---

## RAG Domain

### UC-15 — Weekly Atlassian Docs Crawl

BullMQ repeatable job runs every Monday 02:00 UTC. Crawls 28 Atlassian documentation URLs. Uses SHA-256 content hashing for change detection — unchanged pages are skipped.

### UC-16 — Embed New Documentation Chunks

After crawl, new/changed chunks are embedded via OpenAI `text-embedding-3-small` and stored in pgvector. Typical weekly cost: ~$0.004.

### UC-17 — Trigger Manual RAG Seed

Administrator triggers a manual crawl via `triggerManualCrawl()` or `pnpm --filter @atlasreforge/rag-engine seed`.
