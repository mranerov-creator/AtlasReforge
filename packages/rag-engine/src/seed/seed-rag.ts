import { createPool, initializeSchema } from '../db/pool.factory.js';
import { PgvectorRetriever, INIT_SQL } from '../retrieval/pgvector.retriever.js';
import { RagService } from '../rag.service.js';
import { CRAWL_TARGETS } from '../crawler/crawl-targets.js';
import type { RagEngineConfig } from '../types/rag.types.js';
import { DEFAULT_RAG_CONFIG } from '../types/rag.types.js';

function loadConfig(): RagEngineConfig {
  const databaseUrl = process.env['DATABASE_URL'];
  const openAiApiKey = process.env['OPENAI_API_KEY'];
  if (!databaseUrl) throw new Error('DATABASE_URL required');
  if (!openAiApiKey) throw new Error('OPENAI_API_KEY required');
  return {
    databaseUrl, openAiApiKey,
    ...DEFAULT_RAG_CONFIG,
    crawlConcurrency: parseInt(process.env['CRAWL_CONCURRENCY'] ?? '3', 10),
    crawlDelayMs: parseInt(process.env['CRAWL_DELAY_MS'] ?? '500', 10),
  };
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.floor((ms % 60_000) / 1000)}s`;
}

async function main(): Promise<void> {
  const startMs = Date.now();
  console.log('\n╔═══════════════════════════════════════╗');
  console.log('║   AtlasReforge — RAG Index Seed       ║');
  console.log('╚═══════════════════════════════════════╝\n');

  const config = loadConfig();
  console.log(`Targets: ${CRAWL_TARGETS.length} Atlassian doc URLs`);

  console.log('\n🔌 Connecting to database...');
  const pool = await createPool({ databaseUrl: config.databaseUrl });
  console.log('   ✅ Connected\n');

  console.log('🏗  Initializing schema...');
  await initializeSchema(pool, INIT_SQL);
  console.log('   ✅ Schema ready\n');

  const retriever = new PgvectorRetriever(pool);
  const existing = await retriever.getIndexStats();
  if (existing.totalChunks > 0) {
    console.log(`ℹ️  Existing index: ${existing.totalChunks} chunks → running incremental update\n`);
  }

  const ragService = new RagService(pool, config);
  console.log('🕷  Crawling...\n');

  let fetched = 0, skipped = 0, errors = 0;
  const result = await ragService.runCrawl({
    onProgress: (event) => {
      if (event.type === 'fetch-start') {
        process.stdout.write(`   ${event.url.replace('https://', '').slice(0, 55).padEnd(55)} `);
      } else if (event.type === 'fetch-done') {
        console.log(event.changed ? '✓' : '–');
        event.changed ? fetched++ : skipped++;
      } else if (event.type === 'fetch-error') {
        console.log(`✗ ${event.error.slice(0, 40)}`);
        errors++;
      }
    },
  });

  console.log('\n🧠 Embedding new chunks...');
  const embedded = await ragService.embedPendingChunks(100);
  console.log(`   ✅ Embedded ${embedded} chunks\n`);

  const stats = await retriever.getIndexStats();
  console.log('╔═══════════════════════════════════════╗');
  console.log('║            Seed Complete              ║');
  console.log('╚═══════════════════════════════════════╝');
  console.log(`\nDuration:    ${formatDuration(Date.now() - startMs)}`);
  console.log(`Fetched:     ${fetched} pages`);
  console.log(`Skipped:     ${skipped} (unchanged)`);
  console.log(`Failed:      ${errors}`);
  console.log(`Total index: ${stats.totalChunks} chunks\n`);

  if (errors > 0) {
    result.errors.forEach(e => console.log(`⚠️  ${e.phase}: ${e.url} — ${e.error.slice(0, 60)}`));
  }

  console.log('✅ RAG index ready. Weekly updates: every Monday 02:00 UTC\n');
  await pool.end();
  process.exit(errors > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('\n❌ Seed failed:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
