# ─── Base ─────────────────────────────────────────────────────────────────────
FROM node:20-alpine AS base
RUN corepack enable && corepack prepare pnpm@9.14.2 --activate
WORKDIR /app

# ─── Dependencies ─────────────────────────────────────────────────────────────
FROM base AS deps
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml* ./
COPY packages/tsconfig/package.json packages/tsconfig/
COPY packages/shared/package.json packages/shared/
COPY packages/parser/package.json packages/parser/
COPY packages/llm-orchestrator/package.json packages/llm-orchestrator/
COPY packages/rag-engine/package.json packages/rag-engine/
COPY packages/field-registry/package.json packages/field-registry/
COPY apps/worker/package.json apps/worker/
RUN pnpm install --frozen-lockfile --ignore-scripts

# ─── Builder ──────────────────────────────────────────────────────────────────
FROM deps AS builder
COPY packages/ packages/
COPY apps/worker/ apps/worker/
RUN pnpm --filter @atlasreforge/shared build
RUN pnpm --filter @atlasreforge/parser build
RUN pnpm --filter @atlasreforge/llm-orchestrator build
RUN pnpm --filter @atlasreforge/rag-engine build
RUN pnpm --filter @atlasreforge/field-registry build
RUN pnpm --filter @atlasreforge/worker build

# ─── Development ──────────────────────────────────────────────────────────────
FROM deps AS development
COPY packages/ packages/
COPY apps/worker/ apps/worker/
EXPOSE 3002
CMD ["pnpm", "--filter", "@atlasreforge/worker", "dev"]

# ─── Production ───────────────────────────────────────────────────────────────
FROM node:20-alpine AS production
RUN corepack enable && corepack prepare pnpm@9.14.2 --activate
WORKDIR /app
COPY --from=builder /app/apps/worker/dist ./apps/worker/dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/apps/worker/package.json ./apps/worker/
ENV NODE_ENV=production
EXPOSE 3002
CMD ["node", "apps/worker/dist/main.js"]
