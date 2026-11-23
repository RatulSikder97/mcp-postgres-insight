import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig } from './config.js';
import { buildContext } from './context.js';
import { Database } from './db.js';
import { startHttpServer } from './http.js';
import { createLogger } from './logger.js';
import { createServer, SERVER_NAME } from './server.js';
import { SERVER_VERSION } from './version.js';

/** Process entry point: wires config, pool, transport and graceful shutdown. */
export async function main(env: Record<string, string | undefined> = process.env): Promise<void> {
  const config = loadConfig(env);
  const logger = createLogger(config.LOG_LEVEL);
  const db = new Database({
    connectionString: config.DATABASE_URL,
    allowedSchemas: config.PG_ALLOWED_SCHEMAS,
    statementTimeoutMs: config.STATEMENT_TIMEOUT_MS,
    poolMax: config.PG_POOL_MAX,
    logger,
  });
  const ctx = buildContext(config, db, logger);

  logger.info(
    {
      version: SERVER_VERSION,
      transport: config.MCP_TRANSPORT,
      schemas: config.PG_ALLOWED_SCHEMAS,
      statementTimeoutMs: config.STATEMENT_TIMEOUT_MS,
      queryMaxRows: config.QUERY_MAX_ROWS,
    },
    `${SERVER_NAME} starting`,
  );

  db.ping().then(
    () => {
      logger.info('database reachable');
    },
    (error: unknown) => {
      logger.warn({ err: error }, 'database not reachable yet; tools will report errors until it is');
    },
  );

  let shutdown: () => Promise<void>;
  if (config.MCP_TRANSPORT === 'http') {
    const http = await startHttpServer(ctx);
    shutdown = http.close;
  } else {
    const server = createServer(ctx);
    const transport = new StdioServerTransport();
    await server.connect(transport);
    shutdown = () => server.close();
    process.stdin.on('end', () => void stop('stdin closed'));
  }

  let stopping = false;
  async function stop(reason: string): Promise<void> {
    if (stopping) return;
    stopping = true;
    logger.info({ reason }, 'shutting down');
    try {
      await shutdown();
      await db.close();
    } finally {
      process.exit(0);
    }
  }

  process.on('SIGINT', () => void stop('SIGINT'));
  process.on('SIGTERM', () => void stop('SIGTERM'));
}
