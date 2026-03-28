# API Reference

> Base URL: `http://localhost:3001/api/v1`  
> Content-Type: `application/json` (except file upload: `multipart/form-data`)

---


---

## Automation

### POST /api/v1/automation/import

Server-side proxy that imports an Atlassian Cloud Automation rule JSON to a Jira Cloud instance.
Credentials are used only for this single request and never stored or logged.

**Request:** `application/json`

```json
{
  "ruleJson": "{...}",
  "jiraBaseUrl": "https://yourcompany.atlassian.net",
  "email": "you@company.com",
  "apiToken": "ATATT3x..."
}
```

| Field | Description |
|-------|-------------|
| ruleJson | Atlassian Automation rule export JSON (schema v1) |
| jiraBaseUrl | Must match `*.atlassian.net` HTTPS pattern |
| email | Atlassian account email |
| apiToken | Atlassian API token (generate at id.atlassian.com) |

**Response:** `200 OK`

```json
{
  "success": true,
  "ruleId": "12345",
  "ruleName": "Auto-assign on issue creation",
  "ruleUrl": "https://yourcompany.atlassian.net/jira/settings/automation#/rule/12345",
  "message": "Rule imported successfully. Click the link to review and enable it."
}
```

**Errors:**

| Code | Reason |
|------|--------|
| 400 | Invalid JSON, missing fields, invalid jiraBaseUrl format |
| 401 | Authentication failed — check email and API token |
| 403 | Insufficient permissions — need "Manage automation rules" in Jira |
| 422 | Atlassian returned error — check rule JSON structure |
| 502 | Could not reach Atlassian Cloud — check URL |

> **Security:** API token is sent directly to your Jira instance via server-side Basic Auth. It never passes through AtlasReforge's database or logs.

---
## Jobs

### POST /api/v1/jobs

Submit a script for migration analysis and code generation.

**Request:** `multipart/form-data`

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| file | File | Yes | `.groovy`, `.java`, `.sil`, `.SIL`, `.xml` (Jira workflow export), or `.txt` — max 512 KB for scripts, 2 MB for `.xml` |

**Response:** `202 Accepted`

```json
{
  "jobId": "uuid-v4",
  "statusUrl": "/api/v1/jobs/{jobId}/status",
  "registryUrl": "/api/v1/registry/{jobId}"
}
```

> **Workflow XML:** If the uploaded file is a Jira workflow XML export, the API automatically extracts N embedded scripts and enqueues N independent migration jobs. The response `jobId` refers to the first extracted script. Poll each extracted job individually.

**Errors:**

| Code | Reason |
|------|--------|
| 422 | File type not supported, exceeds 512 KB, or empty |
| 500 | Parser internal error — job not enqueued |

---

### GET /api/v1/jobs/:jobId/status

Poll job progress. Use exponential backoff (1s → max 10s).

**Response:** `200 OK`

```json
{
  "jobId": "uuid-v4",
  "status": "generating",
  "progress": 75,
  "currentStage": "generating",
  "createdAt": "2026-03-28T10:00:00Z"
}
```

**Status Values:**

| Status | Progress | Description |
|--------|----------|-------------|
| queued | 0% | Job in Redis, waiting for worker |
| parsing | 10% | Worker dequeued, parser running |
| classifying | 25% | S1 GPT-4o-mini classifier |
| extracting | 40% | S2 GPT-4o-mini extractor |
| retrieving | 55% | S3 pgvector RAG retrieval |
| generating | 75% | S4 Claude Sonnet 4 code generation |
| validating | 90% | S5 auto-validator |
| completed | 100% | Result available |
| failed | — | Terminal error |

---

### GET /api/v1/jobs/:jobId/result

Retrieve completed migration result.

**Response:** `200 OK` — Full `MigrationResult` object including:
- `cloudReadinessScore`, `cloudReadinessLevel`
- `recommendedTarget` (Forge Native | Forge Remote | ScriptRunner Cloud)
- `businessLogic` — trigger, purpose, conditions, actions
- `forgeFiles[]` — generated Forge code (manifest.yml, src/index.ts, etc.)
- `scriptRunnerCode` — generated SR Cloud Groovy
- `diagram` — Mermaid sequence diagram source
- `oauthScopes[]` — minimal required scopes
- `confidence` — per-area scores with `requiresHumanReview` flags
- `validationIssues[]` — errors, warnings, auto-fixed items
- `fieldMappingPlaceholders[]` — unresolved `ATLAS_*()` references
- `pipeline` — telemetry (tokens, duration, cost)

**Errors:**

| Code | Reason |
|------|--------|
| 404 | Job not found or not yet completed |

---

## Registry

### GET /api/v1/registry/:jobId

Get current registry session state.

**Response:** `200 OK`

```json
{
  "jobId": "uuid-v4",
  "isComplete": false,
  "completionBlockers": ["customfield_10048", "jsmith"],
  "customFields": [
    {
      "serverFieldId": "customfield_10048",
      "cloudFieldId": null,
      "status": "unmapped",
      "usageType": "read",
      "inferredPurpose": "Budget Amount"
    }
  ],
  "groups": [...],
  "users": [
    {
      "serverIdentifier": "jsmith",
      "identifierType": "username",
      "cloudAccountId": null,
      "status": "unmapped",
      "gdprRisk": "high",
      "resolutionStrategy": null
    }
  ],
  "expiresAt": "2026-03-29T10:00:00Z"
}
```

---

### PUT /api/v1/registry/:jobId/fields

Map a Server custom field ID to its Cloud equivalent.

**Request:**

```json
{
  "serverFieldId": "customfield_10048",
  "cloudFieldId": "customfield_10201"
}
```

**Response:** `200 OK` — Updated session state

---

### PUT /api/v1/registry/:jobId/groups

Map a Server group name to a Cloud group UUID.

**Request:**

```json
{
  "serverGroupName": "jira-finance-team-PROD",
  "cloudGroupId": "a1b2c3d4-uuid"
}
```

---

### PUT /api/v1/registry/:jobId/users

Map a username to a Cloud accountId (GDPR resolution).

**Request:**

```json
{
  "serverIdentifier": "jsmith",
  "cloudAccountId": "5b10a2844c20165700ede21g",
  "resolutionStrategy": "manual"
}
```

**Resolution Strategies:** `migration-api` | `manual` | `service-account` | `remove`

---

### POST /api/v1/registry/:jobId/skip

Mark a mapping as "not needed in Cloud".

**Request:**

```json
{
  "type": "field",
  "identifier": "customfield_10048"
}
```

---

### POST /api/v1/registry/:jobId/validate

Validate all mapped values against Jira Cloud REST API v3. Requires Bearer token.

**Headers:** `Authorization: Bearer <jira-cloud-oauth-token>`

**Response:** `200 OK`

```json
{
  "valid": 3,
  "invalid": 1,
  "errors": [
    {
      "type": "field",
      "identifier": "customfield_10201",
      "error": "Field not found in target instance"
    }
  ]
}
```

---

### POST /api/v1/registry/:jobId/resolve

Resolve all `ATLAS_*()` placeholders in provided code.

**Request:**

```json
{
  "code": "const fid = ATLAS_FIELD_ID(\"customfield_10048\");"
}
```

**Response:**

```json
{
  "resolvedCode": "const fid = \"customfield_10201\";",
  "totalPlaceholders": 1,
  "resolved": 1,
  "unresolved": 0,
  "unresolvedPlaceholders": []
}
```

---

### GET /api/v1/registry/:jobId/export

Export registry session as JSON for reuse across jobs.

---

## Health

### GET /health

Liveness probe. Returns `200 OK` with `{"status": "ok"}`.

### GET /health/ready

Readiness probe for container orchestration.

**Response:**

```json
{
  "status": "ok",
  "queues": {
    "migration": "active",
    "ragCrawl": "active"
  },
  "concurrency": 3,
  "uptime": 3600
}
```
