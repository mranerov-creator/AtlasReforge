# 🚀 Guía de Instalación, Arranque y Parada

> AtlasReforge AI — Entorno de desarrollo local

---

## Requisitos previos

| Requisito | Versión mínima | Verificar |
|-----------|---------------|-----------|
| Node.js | 20+ | `node --version` |
| pnpm | 9.x | `pnpm --version` |
| Docker Desktop | 24+ | `docker --version` |
| Git | 2.x | `git --version` |

---

## 1. Instalación (solo la primera vez)

### 1.1 Clonar el repositorio

```bash
git clone https://github.com/mranerov-creator/AtlasReforge.git
cd AtlasReforge
```

### 1.2 Instalar dependencias

```bash
pnpm install
```

### 1.3 Crear archivo de entorno

Crea `.env.local` en la raíz del proyecto:

```bash
# ─── LLM API Keys ──────────────────────────────────────────────
OPENAI_API_KEY=sk-proj-...        # Tu clave OpenAI (S1+S2)
ANTHROPIC_API_KEY=sk-ant-api03-...  # Tu clave Anthropic (S4)

# ─── Infraestructura ───────────────────────────────────────────
DATABASE_URL=postgresql://atlasreforge:atlasreforge_dev@localhost:5432/atlasreforge
REDIS_URL=redis://localhost:6379

# ─── API Server ────────────────────────────────────────────────
PORT=3001
HOST=0.0.0.0
NODE_ENV=development
ALLOWED_ORIGINS=http://localhost:3000

# ─── Worker ────────────────────────────────────────────────────
WORKER_CONCURRENCY=3
HEALTH_PORT=3002

# ─── Seguridad ─────────────────────────────────────────────────
EPHEMERAL_JOB_TTL_MS=300000
DISABLE_PERSISTENCE=true
```

> 💡 **Sin API keys:** Deja `OPENAI_API_KEY` y `ANTHROPIC_API_KEY` vacíos. El worker arrancará en **mock mode** — parser, analyzer y UI funcionan al 100%, pero el código generado será placeholder.

### 1.4 Compilar los paquetes

```bash
pnpm --filter @atlasreforge/shared build
pnpm --filter @atlasreforge/parser build
pnpm --filter @atlasreforge/rag-engine build
pnpm --filter @atlasreforge/llm-orchestrator build
pnpm --filter @atlasreforge/field-registry build
```

---

## 2. Arranque

### 2.1 Iniciar infraestructura (Docker)

> ⚠️ Asegúrate de que **Docker Desktop** está arrancado.

```bash
docker compose -f infra/docker-compose.yml up postgres redis -d
```

Verificar que están sanos:

```bash
docker ps
# Debe mostrar atlasreforge_postgres y atlasreforge_redis en estado "healthy"
```

Verificar pgvector:

```bash
docker exec atlasreforge_postgres psql -U atlasreforge -d atlasreforge -c "\dx"
# Debe mostrar la extensión "vector"
```

### 2.2 Iniciar servicios (3 terminales)

**Terminal 1 — API (NestJS):**

```bash
pnpm --filter @atlasreforge/api dev
```

**Terminal 2 — Worker (BullMQ):**

```bash
pnpm --filter @atlasreforge/worker dev
```

**Terminal 3 — Frontend (React + Vite):**

```bash
pnpm --filter @atlasreforge/web dev
```

### 2.3 Verificar que todo funciona

| Servicio | URL | Respuesta esperada |
|----------|-----|-------------------|
| Frontend | http://localhost:3000 | UI con drop zone |
| API | http://localhost:3001/health | `{"status":"ok"}` |
| Worker | http://localhost:3002/health | `{"status":"ok","queues":{...}}` |
| PostgreSQL | localhost:5432 | Docker healthy |
| Redis | localhost:6379 | Docker healthy |

**Worker con API keys configuradas:**

```
✓ LLM:   configured      ← modo real
```

**Worker sin API keys:**

```
✓ LLM:   mock (no API keys)   ← modo demo
```

---

## 3. Parada

### 3.1 Parar servicios

En cada terminal de los servicios (API, Worker, Web), presiona `Ctrl+C`.

El Worker realiza un **graceful shutdown** automático:
1. Deja de aceptar nuevos jobs
2. Espera a que terminen los jobs en curso (máx 30s)
3. Cierra conexiones BullMQ
4. Sale limpiamente

### 3.2 Parar infraestructura Docker

```bash
docker compose -f infra/docker-compose.yml down
```

> 💡 Los datos de PostgreSQL y Redis se persisten en volúmenes Docker. No se pierden al parar.

Para borrar también los volúmenes (reset total):

```bash
docker compose -f infra/docker-compose.yml down -v
```

---

## 4. Primera prueba

### 4.1 Crear script de prueba

Crea un archivo `test-script.groovy`:

```groovy
import com.atlassian.jira.component.ComponentAccessor

def issueManager = ComponentAccessor.getIssueManager()
def customFieldManager = ComponentAccessor.getCustomFieldManager()
def cf = customFieldManager.getCustomFieldObject("customfield_10048")
def budget = issue.getCustomFieldValue(cf)

if (budget > 50000) {
  def user = ComponentAccessor.getUserManager().getUserByName("finance.lead")
  issue.setAssignee(user)
  issue.store()
}
```

### 4.2 Subir el script

Arrastra el archivo al drop zone en http://localhost:3000.

### 4.3 Resultado esperado

- 🟡 **Cloud Readiness Score:** ~60/100 (YELLOW)
- **Target:** forge-native o forge-or-scriptrunner
- **Issues detectadas:** ComponentAccessor (blocker), username-usage (GDPR)
- **Con API keys:** Código Forge generado en el tab ⚡
- **Sin API keys:** Mensaje "Configure API keys for real generation"

---

## 5. Comandos útiles

| Comando | Descripción |
|---------|-------------|
| `pnpm install` | Instalar/actualizar dependencias |
| `pnpm build` | Compilar todos los paquetes (Turborepo) |
| `pnpm --filter @atlasreforge/rag-engine test` | Ejecutar tests del RAG engine |
| `pnpm run type-check` | Verificar tipos TypeScript |
| `docker compose -f infra/docker-compose.yml logs -f` | Ver logs de Docker |
| `pnpm --filter @atlasreforge/rag-engine seed` | Poblar índice RAG (primera vez) |

---

## Coste estimado por migración

| Componente | Modelo | Coste |
|-----------|--------|-------|
| S1 Clasificador | GPT-4o-mini | ~$0.0001 |
| S2 Extractor | GPT-4o-mini | ~$0.0002 |
| S3 RAG query | text-embedding-3-small | < $0.0001 |
| S4 Generador | Claude Sonnet | ~$0.025 |
| **Total** | — | **~$0.03–$0.05** |
