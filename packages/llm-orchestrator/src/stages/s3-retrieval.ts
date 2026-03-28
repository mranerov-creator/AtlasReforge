/**
 * Stage 3 — RAG Retrieval
 *
 * No LLM involved — pure vector DB similarity search.
 * Uses the patterns detected in S2 as targeted queries.
 *
 * Strategy:
 *   1. Fire one query per detected pattern (PatternId → RAG query)
 *   2. Fire one query per migration target (e.g. "Forge post-function workflow")
 *   3. Fire one query per deprecated API found (e.g. "ComponentAccessor Cloud alternative")
 *   4. Deduplicate results by document ID
 *   5. Sort by similarity score, cap at topK
 *
 * The retriever interface is injected — the actual pgvector implementation
 * lives in @atlasreforge/rag-engine (built next).
 *
 * Input:  S1ClassifierOutput + S2ExtractionOutput
 * Output: S3RetrievalOutput
 */

import type {
  LlmProvider,
  RagDocument,
  RagRetriever,
  S1ClassifierOutput,
  S2ExtractionOutput,
  S3RetrievalOutput,
} from '../types/pipeline.types.js';

// Maximum documents to inject into S4 context
const MAX_CONTEXT_DOCS = 10;
// Per-query retrieval limit
const PER_QUERY_TOP_K = 4;

function buildQueries(
  classifierOutput: S1ClassifierOutput,
  extractionOutput: S2ExtractionOutput,
): ReadonlyArray<string> {
  const queries = new Set<string>();

  // 1. One query per detected pattern
  for (const pattern of extractionOutput.detectedPatterns) {
    queries.add(pattern.relevantRagQuery);
  }

  // 2. Migration target context
  const targetQueryMap: Record<string, string> = {
    'forge-native': `Atlassian Forge ${classifierOutput.moduleType} implementation requestJira`,
    'forge-remote': `Atlassian Forge Remote backend ${classifierOutput.moduleType} timeout`,
    'scriptrunner-cloud': `ScriptRunner Cloud Groovy ${classifierOutput.moduleType} REST API v3`,
    'forge-or-scriptrunner': `Atlassian Forge ${classifierOutput.moduleType} Cloud migration`,
    'manual-rewrite': `Atlassian Cloud ${classifierOutput.moduleType} manual migration approach`,
  };
  const targetQuery = targetQueryMap[classifierOutput.migrationTarget];
  if (targetQuery !== undefined) {
    queries.add(targetQuery);
  }

  // 3. Specific module-type documentation
  const moduleQueryMap: Record<string, string> = {
    'post-function': 'Forge workflow post-function trigger issue transition Cloud',
    'validator': 'Forge workflow validator blocking transition Cloud',
    'listener': 'Forge async webhook event listener Cloud webhook',
    'web-panel': 'Forge Custom UI React web panel Jira issue panel',
    'scheduled-job': 'Forge scheduled trigger cron job Cloud',
    'jql-function': 'Forge JQL function custom search Cloud',
    'rest-endpoint': 'Forge REST endpoint API module Cloud',
  };
  const moduleQuery = moduleQueryMap[classifierOutput.moduleType];
  if (moduleQuery !== undefined) {
    queries.add(moduleQuery);
  }

  // 4. Deprecated API alternatives
  if (classifierOutput.requiresUserMigration) {
    queries.add('Atlassian Cloud accountId user migration GDPR username deprecated');
  }
  if (classifierOutput.requiresFieldMappingRegistry) {
    queries.add('Jira Cloud custom field ID migration Server customfield mapping');
  }
  if (classifierOutput.hasExternalIntegrations) {
    queries.add('Atlassian Forge fetch egress external HTTP API calls');
  }

  // 5. OAuth scopes for the detected module
  queries.add(`Atlassian Forge OAuth scopes ${classifierOutput.moduleType} manifest.yml permissions`);

  return [...queries].slice(0, 8); // Cap at 8 queries to avoid over-retrieval
}

function deduplicateAndRank(
  docs: ReadonlyArray<RagDocument>,
): ReadonlyArray<RagDocument> {
  const seen = new Map<string, RagDocument>();

  for (const doc of docs) {
    const existing = seen.get(doc.id);
    if (existing === undefined || doc.similarity > existing.similarity) {
      seen.set(doc.id, doc);
    }
  }

  return [...seen.values()]
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, MAX_CONTEXT_DOCS);
}

function findStalestDoc(docs: ReadonlyArray<RagDocument>): string | null {
  if (docs.length === 0) return null;

  return docs.reduce((stalest, doc) => {
    return doc.retrievedAt < stalest.retrievedAt ? doc : stalest;
  }).retrievedAt;
}

export async function runS3Retrieval(
  classifierOutput: S1ClassifierOutput,
  extractionOutput: S2ExtractionOutput,
  retriever: RagRetriever,
): Promise<S3RetrievalOutput> {
  const queries = buildQueries(classifierOutput, extractionOutput);

  // Fire all queries in parallel — vector DB reads are fast
  const queryResults = await Promise.all(
    queries.map((query) =>
      retriever
        .retrieve(query, PER_QUERY_TOP_K)
        .catch((): RagDocument[] => []), // Individual query failure doesn't abort pipeline
    ),
  );

  const allDocs = queryResults.flat();
  const deduplicated = deduplicateAndRank(allDocs);
  const stalestDoc = findStalestDoc(deduplicated);

  return {
    documents: deduplicated,
    totalRetrieved: allDocs.length,
    queryCount: queries.length,
    stalestDocAge: stalestDoc,
  };
}

// ─── No-op retriever for testing / RAG-disabled mode ─────────────────────────

export class NoopRagRetriever implements RagRetriever {
  async retrieve(_query: string, _topK: number): Promise<ReadonlyArray<RagDocument>> {
    return [];
  }
}

// ─── In-memory retriever for testing with fixture docs ───────────────────────

export class InMemoryRagRetriever implements RagRetriever {
  constructor(
    private readonly docs: ReadonlyArray<RagDocument>,
  ) {}

  async retrieve(query: string, topK: number): Promise<ReadonlyArray<RagDocument>> {
    // Simple keyword matching for tests — not semantic similarity
    const queryTerms = query.toLowerCase().split(/\s+/);
    return this.docs
      .map((doc) => {
        const text = `${doc.title} ${doc.content}`.toLowerCase();
        const matchCount = queryTerms.filter((t) => text.includes(t)).length;
        return { ...doc, similarity: matchCount / queryTerms.length };
      })
      .filter((d) => d.similarity > 0)
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, topK);
  }
}
