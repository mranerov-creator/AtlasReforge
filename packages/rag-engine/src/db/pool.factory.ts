import pg from 'pg';

const { Pool } = pg;

export interface PoolConfig {
  readonly databaseUrl: string;
  readonly maxConnections?: number;
  readonly idleTimeoutMs?: number;
  readonly connectTimeoutMs?: number;
}

export async function createPool(
  config: PoolConfig,
  maxRetries = 5,
): Promise<pg.Pool> {
  const pool = new Pool({
    connectionString: config.databaseUrl,
    max: config.maxConnections ?? 10,
    idleTimeoutMillis: config.idleTimeoutMs ?? 30_000,
    connectionTimeoutMillis: config.connectTimeoutMs ?? 10_000,
    allowExitOnIdle: false,
  });

  let lastError: Error | undefined;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const client = await pool.connect();
      try {
        await client.query('SELECT extname FROM pg_extension WHERE extname = $1', ['vector']);
        console.log(`[DB] Connected to postgres (attempt ${attempt}/${maxRetries})`);
      } finally {
        client.release();
      }
      return pool;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (attempt < maxRetries) {
        const delayMs = Math.min(1000 * Math.pow(2, attempt - 1), 10_000);
        console.warn(`[DB] Connection failed (attempt ${attempt}/${maxRetries}): ${lastError.message}`);
        console.warn(`[DB] Retrying in ${delayMs}ms...`);
        await new Promise(resolve => setTimeout(resolve, delayMs));
      }
    }
  }

  await pool.end().catch(() => undefined);
  throw new DatabaseConnectionError(
    `Failed to connect to postgres after ${maxRetries} attempts: ${lastError?.message ?? 'unknown'}`,
  );
}

export async function initializeSchema(
  pool: pg.Pool,
  initSql: string,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('CREATE EXTENSION IF NOT EXISTS vector');
    await client.query(initSql);
    console.log('[DB] Schema initialized (pgvector + rag_documents table)');
  } finally {
    client.release();
  }
}

export async function checkPoolHealth(pool: pg.Pool): Promise<boolean> {
  try {
    const result = await pool.query<{ now: Date }>('SELECT NOW() as now');
    return result.rows[0] !== undefined;
  } catch {
    return false;
  }
}

export class DatabaseConnectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DatabaseConnectionError';
  }
}
