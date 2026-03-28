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
COPY apps/api/package.json apps/api/
RUN pnpm install --frozen-lockfile --ignore-scripts

# ─── Builder ──────────────────────────────────────────────────────────────────
FROM deps AS builder
COPY packages/ packages/
COPY apps/api/ apps/api/
RUN pnpm --filter @atlasreforge/tsconfig build || true
RUN pnpm --filter @atlasreforge/shared build
RUN pnpm --filter @atlasreforge/parser build
RUN pnpm --filter @atlasreforge/llm-orchestrator build
RUN pnpm --filter @atlasreforge/rag-engine build
RUN pnpm --filter @atlasreforge/field-registry build
RUN pnpm --filter @atlasreforge/api build

# ─── Development ──────────────────────────────────────────────────────────────
FROM deps AS development
COPY packages/ packages/
COPY apps/api/ apps/api/
EXPOSE 3001
CMD ["pnpm", "--filter", "@atlasreforge/api", "dev"]

# ─── Production ───────────────────────────────────────────────────────────────
FROM node:20-alpine AS production
RUN corepack enable && corepack prepare pnpm@9.14.2 --activate
WORKDIR /app
COPY --from=builder /app/apps/api/dist ./apps/api/dist
COPY --from=builder /app/packages/*/dist ./packages/
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/apps/api/package.json ./apps/api/
ENV NODE_ENV=production
EXPOSE 3001
CMD ["node", "apps/api/dist/main.js"]
